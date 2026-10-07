import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, win32 as win32Path } from "node:path";

import {
  cmdFolder,
  cmdIngestLocal,
  credentialScannerFingerprint,
  declaredUploadFolderFor,
  planLoad,
  uploadFoldersOf,
} from "../brain.mjs";
import { prepareFeedAddition } from "../operations/feed-folders.mjs";
import { batchStream, removedSinceLastRun, walk } from "../ingest/run.mjs";

const ROOT = process.env.LFEED_ROUND2_TEST_ROOT || process.env.HOME;
if (!ROOT) throw new Error("LFEED_ROUND2_TEST_ROOT or HOME is required");
mkdirSync(ROOT, { recursive: true });
const sandbox = mkdtempSync(join(ROOT, "feed-folders-round2-"));

function manifest(upload = { enabled: true, folders: [] }) {
  return {
    manifest_version: 1,
    client: { slug: "fixture-brain", display_name: "Fixture Brain" },
    brain: { version: "0.4.9", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
    corpora: { upload },
  };
}

function directoryFs({ linkPaths = [], realpaths = new Map(), platform = "darwin" } = {}) {
  const pathApi = platform === "win32" ? win32Path : null;
  const normalize = (value) => platform === "win32"
    ? pathApi.normalize(String(value)).toLowerCase()
    : String(value).replace(/\/+$/u, "") || "/";
  const links = new Set(linkPaths.map(normalize));
  return {
    existsSync: () => true,
    lstatSync: (path) => ({
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => links.has(normalize(path)),
    }),
    realpathNative: (path) => realpaths.get(normalize(path)) || (platform === "win32" ? pathApi.normalize(path) : path),
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: 0 }),
  };
}

async function ingestDecision(m, manifestPath, path, source) {
  const calls = { locks: 0, walks: 0, diffs: 0, removals: [], decisions: [] };
  const state = {
    version: 1,
    done: { "gone.txt": "synthetic-hash" },
    skipped: {},
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
  };
  let error = null;
  try {
    await cmdIngestLocal(m, manifestPath, {
      path,
      source,
      "dry-run": true,
    }, {
      onFeedIngestDecision: (decision) => calls.decisions.push(decision),
      withSourceIngestLock: async (_settings, task) => {
        calls.locks += 1;
        return task({ assertOwned() {} });
      },
      ingestLib: async () => ({
        walk: () => {
          calls.walks += 1;
          return { files: [], skipped: [], complete: true };
        },
        loadState: () => structuredClone(state),
        saveState: () => { throw new Error("dry-run state write was not expected"); },
        removedSinceLastRun: (...args) => {
          calls.diffs += 1;
          return removedSinceLastRun(...args);
        },
        batchStream,
      }),
      resolveAdminKey: () => { throw new Error("credential lookup was not expected"); },
      applyDriveRemovals: async ({ uids }) => {
        calls.removals.push(uids);
        return { applied: 0, pending: 0 };
      },
    });
  } catch (caught) {
    error = caught;
  }
  return { calls, error };
}

test("probe A: equivalent feed paths stay append-only and an ordinary mirror stays unchanged", async () => {
  const root = mkdtempSync(join(sandbox, "probe-a-"));
  const feed = join(root, "Feed");
  const mirror = join(root, "Mirror");
  const manifestPath = join(root, "brain.manifest.json");
  mkdirSync(feed);
  mkdirSync(mirror);
  writeFileSync(manifestPath, "{}\n");

  const safe = manifest({
    enabled: true,
    folders: [{ path: feed, source: "feed_source", feed: true }],
  });
  const alias = await ingestDecision(safe, manifestPath, join(feed, "."), "feed_source");
  assert.ifError(alias.error);
  assert.equal(alias.calls.locks, 1);
  assert.equal(alias.calls.walks, 1);
  assert.equal(alias.calls.diffs, 0);
  assert.deepEqual(alias.calls.removals, []);
  assert.deepEqual(alias.calls.decisions.map((entry) => entry.outcome), ["append-only"]);

  const ordinary = manifest({
    enabled: true,
    folders: [{ path: mirror, source: "mirror_source" }],
  });
  const control = await ingestDecision(ordinary, manifestPath, mirror, "mirror_source");
  assert.ifError(control.error);
  assert.equal(control.calls.locks, 1);
  assert.equal(control.calls.walks, 1);
  assert.equal(control.calls.diffs, 1, "the pre-feed mirror behavior still compares missing files");
  assert.deepEqual(control.calls.removals, [[], ["mirror_source:gone.txt"]]);
  assert.deepEqual(control.calls.decisions.map((entry) => entry.outcome), ["mirror"]);
});

test("probe A: shared-source and tree re-declarations refuse before a removal path", async () => {
  const root = mkdtempSync(join(sandbox, "probe-a-conflict-"));
  const feed = join(root, "Feed");
  const other = join(root, "Other");
  const manifestPath = join(root, "brain.manifest.json");
  mkdirSync(feed);
  mkdirSync(other);
  writeFileSync(manifestPath, "{}\n");

  for (const folders of [
    [{ path: feed, source: "shared_source", feed: true }, { path: other, source: "shared_source" }],
    [{ path: feed, source: "shared_source", feed: true }, { path: join(feed, "."), source: "other_source" }],
  ]) {
    const conflicted = manifest({ enabled: true, folders });
    const plan = await planLoad({ m: conflicted, manifestPath, probes: {} });
    const upload = plan.find((entry) => entry.key === "upload");
    assert.equal(upload.status, "unavailable");
    assert.match(upload.reason, /feed|append-only|overlap/i);
    const result = await ingestDecision(conflicted, manifestPath, folders[1].path, folders[1].source);
    assert.match(result.error?.message || "", /feed|append-only|overlap|ambiguous/i);
    assert.equal(result.calls.decisions.length, 1, "the refusal reaches the feed-ingest policy decision");
    assert.equal(result.calls.decisions[0].outcome, "refused");
    assert.equal(result.calls.locks, 0);
    assert.equal(result.calls.walks, 0);
    assert.deepEqual(result.calls.removals, []);
  }
});

test("feed lookup recognizes normalized, relative, case-variant, and child paths", () => {
  const feed = "/Users/Owner/Brain Feeds/Files";
  const m = manifest({ enabled: true, folders: [{ path: feed, source: "feed_source", feed: true }] });
  const options = {
    platform: "darwin",
    cwd: "/Users/Owner",
    realpathNative: (path) => path,
  };
  for (const alias of [
    `${feed}/`,
    `${feed}/.`,
    "/users/owner/brain feeds/files",
    "Brain Feeds/Files",
    `${feed}/Nested`,
  ]) {
    assert.equal(declaredUploadFolderFor(m, alias, options)?.feed, true, alias);
  }
  assert.equal(declaredUploadFolderFor(m, "/Users/Owner/Elsewhere", options), null);
});

test("source ownership refuses unnamed upload and watched-folder collisions with a passing control", () => {
  const io = directoryFs();
  const events = [];
  for (const legacyEntry of ["/synthetic/legacy", { path: "/synthetic/legacy" }]) {
    const base = manifest({ enabled: true, folders: [legacyEntry] });
    assert.throws(
      () => prepareFeedAddition(base, "/synthetic/feed", "upload", {
        platform: "darwin", fs: io, onDecision: (event) => events.push(event),
      }),
      /source|assigned|reserved/i,
    );
    assert.equal(events.at(-1).outcome, "refused");
  }
  assert.equal(events.length, 2);

  const watched = manifest({ enabled: true, folders: [] });
  watched.corpora.local_folder = { enabled: true, path: "/synthetic/watched", source: "feed_source" };
  assert.throws(
    () => prepareFeedAddition(watched, "/synthetic/feed", "feed_source", {
      platform: "darwin", fs: io, onDecision: (event) => events.push(event),
    }),
    /source|assigned|reserved/i,
  );
  assert.equal(events.length, 3);
  assert.equal(events[2].outcome, "refused");

  const connected = manifest({ enabled: true, folders: [] });
  connected.corpora.google_drive = { enabled: true };
  assert.throws(
    () => prepareFeedAddition(connected, "/synthetic/feed", "drive", {
      platform: "darwin", fs: io, onDecision: (event) => events.push(event),
    }),
    /source|assigned|reserved/i,
  );
  assert.equal(events.length, 4);
  assert.equal(events[3].outcome, "refused");

  const base = manifest({ enabled: true, folders: ["/synthetic/legacy"] });
  const control = prepareFeedAddition(base, "/synthetic/feed", "distinct_source", {
    platform: "darwin", fs: io, onDecision: (event) => events.push(event),
  });
  assert.equal(control.changed, true);
  assert.equal(events.at(-1).outcome, "accepted");
});

test("probe B: adding a feed preserves legacy path and paths load legs", async () => {
  const root = mkdtempSync(join(sandbox, "probe-b-legacy-"));
  const oldOne = join(root, "Old one");
  const oldTwo = join(root, "Old two");
  const next = join(root, "Next");
  for (const path of [oldOne, oldTwo, next]) mkdirSync(path);

  for (const upload of [
    { enabled: true, path: oldOne },
    { enabled: true, paths: [oldTwo] },
  ]) {
    const beforeManifest = manifest(upload);
    const before = await planLoad({ m: beforeManifest, manifestPath: join(root, "brain.manifest.json"), probes: {} });
    const added = prepareFeedAddition(beforeManifest, next, "feed_source", { platform: "darwin" });
    const after = await planLoad({ m: added.manifest, manifestPath: join(root, "brain.manifest.json"), probes: {} });
    assert.deepEqual(
      before.find((entry) => entry.key === "upload").legs.map((leg) => leg.detail),
      upload.path ? [oldOne] : [oldTwo],
    );
    assert.deepEqual(
      after.find((entry) => entry.key === "upload").legs.map((leg) => leg.detail),
      [...(upload.path ? [oldOne] : [oldTwo]), realpathSync(next)],
    );
    assert.deepEqual(
      uploadFoldersOf(added.manifest.corpora.upload).map((entry) => entry.path),
      [...(upload.path ? [oldOne] : [oldTwo]), realpathSync(next)],
    );
  }
});

test("probe B: POSIX, drive, and UNC roots refuse while a sibling control is accepted", () => {
  const cases = [
    {
      platform: "darwin",
      existing: "/synthetic/feed",
      root: "/",
      sibling: "/other/feed",
      fs: directoryFs(),
    },
    {
      platform: "win32",
      existing: "C:\\Data\\Feed",
      root: "C:\\",
      sibling: "D:\\Other\\Feed",
      fs: directoryFs({ platform: "win32" }),
    },
    {
      platform: "win32",
      existing: "\\\\server\\share\\Feed",
      root: "\\\\server\\share\\",
      sibling: "\\\\server\\other\\Feed",
      fs: directoryFs({ platform: "win32" }),
    },
  ];
  for (const item of cases) {
    const events = [];
    const m = manifest({ enabled: true, folders: [{ path: item.existing, source: "existing", feed: true }] });
    assert.throws(
      () => prepareFeedAddition(m, item.root, "root_feed", {
        platform: item.platform, fs: item.fs, onDecision: (event) => events.push(event),
      }),
      /root|parent or child/i,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "refused");
    const control = prepareFeedAddition(m, item.sibling, "sibling_feed", {
      platform: item.platform, fs: item.fs, onDecision: (event) => events.push(event),
    });
    assert.equal(control.changed, true);
    assert.equal(events.at(-1).outcome, "accepted");
  }
});

test("probe B: linked ancestors, link-dot spellings, and create-feeds aliases refuse", async () => {
  const root = mkdtempSync(join(sandbox, "probe-b-links-"));
  const target = join(root, "Target");
  const child = join(target, "Child");
  const alias = join(root, "Alias");
  mkdirSync(child, { recursive: true });
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

  for (const path of [join(alias, "Child"), join(alias, ".")]) {
    const events = [];
    assert.throws(
      () => prepareFeedAddition(manifest(), path, "feed_source", {
        platform: process.platform, onDecision: (event) => events.push(event),
      }),
      /symbolic link|reparse point/i,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "refused");
  }
  const control = prepareFeedAddition(manifest(), child, "feed_source", { platform: process.platform });
  assert.equal(control.changed, true);

  const configRoot = join(root, "config");
  const manifestPath = join(configRoot, "brain.manifest.json");
  mkdirSync(configRoot);
  writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const createEvents = [];
  let createError = null;
  try {
    await cmdFolder(manifestPath, ["create-feeds"], {
      platform: process.platform,
      home: alias,
      onFeedDecision: (event) => createEvents.push(event),
      now: () => new Date("2026-10-06T20:00:00.000Z"),
    });
  } catch (error) {
    createError = error;
  }
  assert.match(createError?.message || "", /symbolic link|reparse point/i);
  assert.equal(createEvents.length, 1, "create-feeds reaches one refusal before directory creation");
  assert.equal(createEvents[0].outcome, "refused");
  assert.equal(existsSync(join(target, "Brain Feeds")), false);
  assert.equal(readFileSync(manifestPath, "utf8"), `${JSON.stringify(manifest(), null, 2)}\n`);
});

test("probe B: a simulated Windows junction parent refuses with a normal-directory control", () => {
  const alias = "C:\\Users\\Owner\\Alias";
  const child = `${alias}\\Child`;
  const actual = "C:\\Users\\Owner\\Actual\\Child";
  const io = directoryFs({
    platform: "win32",
    linkPaths: [alias],
    realpaths: new Map([[win32Path.normalize(child).toLowerCase(), actual]]),
  });
  const events = [];
  assert.throws(
    () => prepareFeedAddition(manifest(), child, "feed_source", {
      platform: "win32", fs: io, onDecision: (event) => events.push(event),
    }),
    /symbolic link|reparse point/i,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "refused");
  const control = prepareFeedAddition(manifest(), actual, "feed_source", {
    platform: "win32", fs: io, onDecision: (event) => events.push(event),
  });
  assert.equal(control.changed, true);
  assert.equal(events.at(-1).outcome, "accepted");
});

test("probe C: globstar exclusions cover root and nested files with slash controls", () => {
  const root = mkdtempSync(join(sandbox, "probe-c-"));
  const nested = join(root, "Nested");
  mkdirSync(nested);
  writeFileSync(join(root, "current.txt"), "Synthetic current record with enough text for the walk.\n");
  writeFileSync(join(nested, "nested.txt"), "Synthetic nested record with enough text for the walk.\n");

  for (const pattern of ["**/*.txt", "**\\*.txt"]) {
    const guarded = walk(root, { feedMode: true, exclude: [pattern] });
    assert.equal(guarded.complete, true);
    assert.deepEqual(guarded.files, []);
    assert.equal(guarded.skipped.filter((entry) => entry.adjudication === "feed_exclusion").length, 2);
  }
  const control = walk(root, { feedMode: true, exclude: ["**/*.md"] });
  assert.equal(control.complete, true);
  assert.deepEqual(control.files.map((file) => file.rel).sort(), ["Nested/nested.txt", "current.txt"]);
});

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
