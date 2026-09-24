import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FOLDER_MARKER,
  createMacFolderBookmark,
  findFolderMarkers,
  oldPathOwnerFileWarnings,
  reconcileTrackedFolders,
  relativeFolderStateIsPortable,
  resolveMacFolderBookmark,
  resolveTrackedManifestPath,
} from "../operations/folder-identity.mjs";
import { hydrateDatalessFile, prepare, removedSinceLastRun, walk } from "../ingest/run.mjs";
import {
  readInstalledManifest,
  rememberInstalledManifest,
} from "../operations/installed-manifest.mjs";
import {
  installFolderScheduler,
  statusFolderScheduler,
} from "../operations/folder-scheduler.mjs";
import { regenerateMovedManifestReferences } from "../brain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const brain = join(here, "..", "brain.mjs");

function runBrain(args, home) {
  return spawnSync(process.execPath, [brain, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      SystemRoot: process.env.SystemRoot,
    },
  });
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "brain-folder-relocation-"));
  const brainHome = join(home, "Brain Home");
  const source = join(home, "Source Folder");
  mkdirSync(brainHome, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "record.txt"), "A synthetic record with enough words to be indexed safely.\n");
  const manifestPath = join(brainHome, "brain.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    client: { slug: "fixture-brain", display_name: "the owner" },
    brain: { domain: "fixture.invalid" },
    corpora: {
      upload: { enabled: true, folders: [{ path: source, source: "documents" }] },
      local_folder: { enabled: true, path: source, source: "documents" },
    },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
  }, null, 2)}\n`);
  return { home, brainHome, source, manifestPath };
}

{
  const f = fixture();
  const first = runBrain(["ingest", f.manifestPath, "--path", f.source, "--dry-run"], f.home);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(
    existsSync(join(f.source, ".financial-brain-folder.json")),
    true,
    "first use must establish the folder marker before a later move",
  );

  const moved = join(f.home, "Renamed Source Folder");
  renameSync(f.source, moved);
  const after = runBrain(["ingest", f.manifestPath, "--path", f.source, "--dry-run"], f.home);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /You moved source:documents from .* to .*\. I've updated myself\./);
  const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  assert.equal(realpathSync(manifest.corpora.local_folder.path), realpathSync(moved));
  assert.equal(realpathSync(manifest.corpora.upload.folders[0].path), realpathSync(moved));
}

console.log("PASS  a source folder move is adopted before the real ingest path decides files vanished");

{
  const f = fixture();
  const initial = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  reconcileTrackedFolders(f.manifestPath, initial, {
    platform: "linux",
    home: f.home,
    stateDirectory: join(f.home, "state"),
  });
  const firstWalk = walk(f.source);
  assert.equal(firstWalk.complete, true);
  const firstPrepared = await prepare(firstWalk.files[0], { sourceName: "documents" });
  const portableState = { done: { [firstPrepared.envelope.source_id]: firstPrepared.hash } };
  assert.equal(relativeFolderStateIsPortable(portableState), true);

  const moved = join(f.home, "Source Renamed Again");
  renameSync(f.source, moved);
  const current = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  const adopted = reconcileTrackedFolders(f.manifestPath, current, {
    platform: "linux",
    home: f.home,
    stateDirectory: join(f.home, "state"),
    candidateRoots: [f.home],
  });
  assert.equal(adopted.changes.length, 1);
  const secondWalk = walk(moved);
  const secondPrepared = await prepare(secondWalk.files[0], { sourceName: "documents" });
  const present = new Set(secondWalk.files.map((file) => file.rel.split("\\").join("/")));
  assert.equal(removedSinceLastRun(new Set(Object.keys(portableState.done)), present).length, 0);
  assert.equal(secondPrepared.envelope.source_id, firstPrepared.envelope.source_id);
  assert.equal(secondPrepared.hash, portableState.done[secondPrepared.envelope.source_id]);
}
console.log("PASS  a moved identical tree has zero missing, zero re-sent, and no removal plan");

{
  const f = fixture();
  const stateDirectory = join(f.home, "state");
  const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  reconcileTrackedFolders(f.manifestPath, manifest, {
    platform: "darwin",
    home: f.home,
    stateDirectory,
    createBookmark: () => "injected-bookmark",
  });
  const moved = join(f.home, "Bookmark Renamed Source");
  renameSync(f.source, moved);
  const adopted = reconcileTrackedFolders(
    f.manifestPath,
    JSON.parse(readFileSync(f.manifestPath, "utf8")),
    {
      platform: "darwin",
      home: f.home,
      stateDirectory,
      candidateRoots: [],
      createBookmark: () => "refreshed-bookmark",
      resolveBookmark: (bookmark) => bookmark === "injected-bookmark" ? moved : null,
    },
  );
  assert.equal(adopted.changes[0]?.via, "bookmark");
  assert.equal(realpathSync(adopted.changes[0]?.newPath), realpathSync(moved));
}
console.log("PASS  the bookmark branch resolves through an injected non-host resolver");

{
  const f = fixture();
  const stateDirectory = join(f.home, "state");
  const native = (command, args = []) => command === "fsutil"
    ? { status: 0, stdout: `File ID is ${String(args[2]).includes("Source") ? "0x1234" : "0xabcd"}`, stderr: "" }
    : { status: 0, stdout: "", stderr: "" };
  reconcileTrackedFolders(f.manifestPath, JSON.parse(readFileSync(f.manifestPath, "utf8")), {
    platform: "win32", home: f.home, stateDirectory, spawnSync: native,
  });
  const moved = join(f.home, "Windows Renamed Source");
  renameSync(f.source, moved);
  rmSync(join(moved, FOLDER_MARKER));
  const adopted = reconcileTrackedFolders(
    f.manifestPath,
    JSON.parse(readFileSync(f.manifestPath, "utf8")),
    { platform: "win32", home: f.home, stateDirectory, candidateRoots: [f.home], spawnSync: native },
  );
  assert.equal(adopted.changes[0]?.via, "file-id");
  assert.equal(realpathSync(adopted.changes[0]?.newPath), realpathSync(moved));
}
console.log("PASS  Windows can recover a moved folder by its injected NTFS file id");

{
  const f = fixture();
  const stateDirectory = join(f.home, "state");
  const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  reconcileTrackedFolders(f.manifestPath, manifest, {
    platform: "linux", home: f.home, stateDirectory, writeLocator: true,
  });
  const copyOne = join(f.home, "Source Copy One");
  const copyTwo = join(f.home, "Source Copy Two");
  cpSync(f.source, copyOne, { recursive: true });
  cpSync(f.source, copyTwo, { recursive: true });
  rmSync(f.source, { recursive: true });
  const before = readFileSync(f.manifestPath, "utf8");
  let ambiguous = null;
  try {
    reconcileTrackedFolders(f.manifestPath, JSON.parse(before), {
      platform: "linux", home: f.home, stateDirectory, candidateRoots: [f.home],
    });
  } catch (error) { ambiguous = error; }
  assert.equal(ambiguous?.code, "FOLDER_AMBIGUOUS");
  assert.equal(ambiguous?.detail?.decision_reached, true, "the negative control reached the copy decision");
  assert.deepEqual(ambiguous?.detail?.matches, [copyOne, copyTwo].map((path) => realpathSync(path)).sort());
  assert.equal(readFileSync(f.manifestPath, "utf8"), before, "an ambiguous copy changes nothing");

  const unrelated = join(f.home, "Unrelated Folder");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, FOLDER_MARKER), `${JSON.stringify({
    id: "00000000-0000-4000-8000-000000000000",
    role: "source:documents",
    brain: "11111111-1111-4111-8111-111111111111",
  })}\n`);
  const identityState = JSON.parse(readFileSync(join(f.brainHome, ".brain-folder-identities.json"), "utf8"));
  const tracked = identityState.folders.find((item) => item.role === "source:documents");
  const search = findFolderMarkers({ ...tracked, brain_id: identityState.brain_id }, {
    candidateRoots: [unrelated], platform: "linux",
  });
  assert.deepEqual(search.matches, [], "a different marker id is ignored");
}
console.log("PASS  two copied markers refuse after a reached decision and an unrelated id is ignored");

{
  const f = fixture();
  const stateDirectory = join(f.home, "state");
  const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  reconcileTrackedFolders(f.manifestPath, manifest, {
    platform: "linux", home: f.home, stateDirectory, writeLocator: true,
  });
  rmSync(f.source, { recursive: true });
  const before = readFileSync(f.manifestPath, "utf8");
  let missing = null;
  try {
    reconcileTrackedFolders(f.manifestPath, JSON.parse(before), {
      platform: "linux", home: f.home, stateDirectory, candidateRoots: [f.home],
    });
  } catch (error) { missing = error; }
  assert.equal(missing?.code, "FOLDER_MISSING");
  assert.equal(missing?.detail?.decision_reached, true, "the negative control reached the missing decision");
  assert.match(missing.message, /Nothing was deleted.*brain relocate --to <new>/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
}
console.log("PASS  a deleted tracked folder fails loudly and changes nothing");

{
  const root = mkdtempSync(join(tmpdir(), "brain-dataless-"));
  const path = join(root, "offloaded.txt");
  writeFileSync(path, "");
  let downloads = 0;
  const hydration = hydrateDatalessFile(path, {
    platform: "darwin",
    isDataless: () => true,
    requestDownload: () => { downloads++; return true; },
    waitMs: 20,
    intervalMs: 10,
    pause: () => {},
  });
  assert.equal(hydration.downloadRequested, true);
  assert.equal(downloads, 1, "the negative control reached the download decision");
  const result = walk(root, {
    hydrateDataless: () => hydration,
    datalessOptions: { probeEveryFile: true },
  });
  assert.equal(result.complete, true);
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped[0].adjudication, "preserve_dataless_file");
  assert.equal(result.skipped[0].coverage_gap, false);
  assert.equal(statSync(path).size, 0, "no placeholder was written over the offloaded item");
}
console.log("PASS  an offloaded file requests download, stays protected, and gets no placeholder");

{
  const f = fixture();
  const skill = join(f.home, ".claude", "scheduled-tasks", "fixture", "SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, `Use ${f.source} for the fixture.\n`);
  const ownerFile = join(f.brainHome, "owner-note.md");
  writeFileSync(ownerFile, `The prior path is ${f.source}.\n`);
  const beforeSkill = readFileSync(skill, "utf8");
  const beforeOwner = readFileSync(ownerFile, "utf8");
  const warnings = oldPathOwnerFileWarnings({ brainHome: f.brainHome, oldPath: f.source, home: f.home });
  assert.deepEqual(warnings, [ownerFile, skill].sort());
  assert.equal(readFileSync(skill, "utf8"), beforeSkill);
  assert.equal(readFileSync(ownerFile, "utf8"), beforeOwner);
}
console.log("PASS  old-path warnings inspect only approved owner scopes and edit nothing");

{
  const f = fixture();
  const stateDirectory = join(f.home, "state");
  const launchCalls = [];
  const schedulerOptions = {
    platform: "darwin",
    home: f.home,
    brainPath: brain,
    launchctl: (args) => {
      launchCalls.push(args);
      if (args[0] === "print") return { status: 113, stderr: "not loaded" };
      return { status: 0, stdout: "" };
    },
    uid: 501,
  };
  const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  reconcileTrackedFolders(f.manifestPath, manifest, {
    platform: "linux", home: f.home, stateDirectory, writeLocator: true,
  });
  rememberInstalledManifest(f.manifestPath, { stateDirectory });
  installFolderScheduler(f.manifestPath, schedulerOptions);
  const oldManifestPath = f.manifestPath;
  const movedHome = join(f.home, "Brain Home Renamed");
  renameSync(f.brainHome, movedHome);
  const resolution = resolveTrackedManifestPath(oldManifestPath, {
    platform: "linux", home: f.home, stateDirectory, candidateRoots: [f.home],
  });
  const unrelatedMcp = { command: "unrelated", args: ["keep"], env: { KEEP: "yes" } };
  const mcpConfig = { mcpServers: { unrelated: unrelatedMcp } };
  let mcpCalls = 0;
  const receipt = await regenerateMovedManifestReferences({
    oldManifestPath,
    manifestPath: resolution.path,
  }, {
    installedManifestOptions: { stateDirectory },
    folderOptions: { stateDirectory },
    wireAgents: async (_manifest, nextPath, wireOptions) => {
      mcpCalls++;
      assert.equal(nextPath, resolution.path);
      assert.equal(wireOptions.existingOnly, true);
      assert.deepEqual(mcpConfig.mcpServers.unrelated, unrelatedMcp);
      return { wired: ["Claude Code"], failures: [], skipped: [], preserved: [] };
    },
    schedulerRefreshOptions: { platform: "darwin", schedulerOptions },
  });
  assert.equal(realpathSync(readInstalledManifest({ stateDirectory })), realpathSync(resolution.path));
  assert.equal(mcpCalls, 1);
  assert.equal(receipt.schedulers.some((item) => item.label === "watched folder"), true);
  const status = statusFolderScheduler(resolution.path, schedulerOptions);
  assert.equal(status.installed, true);
  assert.equal(status.definitionMatches, true);
  assert.equal(existsSync(receipt.backup), true);
  assert.deepEqual(mcpConfig.mcpServers.unrelated, unrelatedMcp);
}
console.log("PASS  a moved manifest home repairs its pointer, target MCP entry, and installed plist with backup");

if (process.platform === "darwin") {
  const root = mkdtempSync(join(tmpdir(), "brain-bookmark-real-"));
  const original = join(root, "Original Folder");
  const renamed = join(root, "Renamed Folder");
  mkdirSync(original);
  const bookmark = createMacFolderBookmark(original);
  assert.ok(bookmark, "the native JXA bookmark must be created on macOS");
  renameSync(original, renamed);
  assert.equal(realpathSync(resolveMacFolderBookmark(bookmark)), realpathSync(renamed));
  console.log("PASS  a real macOS NSURL bookmark resolves after a same-volume rename");
}
