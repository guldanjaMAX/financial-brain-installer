import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cmdIngestLocal,
  cmdLoad,
  cmdProvenanceAssess,
  completeSetupFolderStep,
  inspectProvenanceRepairReadiness,
  retiredLocalFolderOf,
  runApprovedProvenanceRewalk,
  supportErrorCode,
} from "../brain.mjs";
import * as ingestRuntime from "../ingest/run.mjs";

const ROOT = process.env.FOLDER_OFF_TEST_ROOT || tmpdir();
mkdirSync(ROOT, { recursive: true });
const sandbox = mkdtempSync(join(ROOT, "folder-retired-guard-"));
const retiredAt = "2026-09-28T16:36:00.000Z";

function manifestBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture({ retired = true, retiredBy = "brain folder off", uploadEnabled = false } = {}) {
  const base = mkdtempSync(join(sandbox, "case-"));
  const home = join(base, "home");
  const retiredPath = join(base, "Retired Folder");
  const unrelated = join(base, "Current Reports");
  const manifestPath = join(base, "brain.manifest.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(retiredPath, "A"), { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(retiredPath, "fixture.txt"), "synthetic retired fixture text with enough words to ingest safely\n");
  writeFileSync(join(retiredPath, "A", "nested.txt"), "synthetic nested fixture text with enough words to ingest safely\n");
  writeFileSync(join(unrelated, "report.txt"), "synthetic unrelated report text with enough words to ingest safely\n");
  const folderStat = statSync(realpathSync.native(retiredPath), { bigint: true });
  const local = {
    enabled: !retired,
    path: retiredPath,
    source: "documents",
    ...(retired ? {
      retired_at: retiredAt,
      retired_path: retiredPath,
      retired_source: "documents",
      retired_identity: {
        realpath: realpathSync.native(retiredPath),
        dev: String(folderStat.dev),
        ino: String(folderStat.ino),
      },
      retired_by: retiredBy,
    } : {}),
  };
  const manifest = {
    manifest_version: 1,
    client: { slug: "fixture-brain", display_name: "Fixture Brain" },
    brain: { version: "0.4.9", domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", storage: "d1" } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
    corpora: {
      local_folder: local,
      upload: { enabled: uploadEnabled, folders: [{ path: retiredPath, source: "documents" }] },
      calendar: { enabled: true },
    },
  };
  writeFileSync(manifestPath, manifestBytes(manifest), { mode: 0o600 });
  const statePath = join(base, ".brain-ingest-documents.json");
  const stateBytes = `${JSON.stringify({ version: 1, done: {}, skipped: {} }, null, 2)}\n`;
  writeFileSync(statePath, stateBytes, { mode: 0o600 });
  return { base, home, retiredPath, unrelated, manifestPath, manifest, statePath, stateBytes };
}

function ingestOptions(f, counters) {
  return {
    sourceIngestLockOptions: { home: f.home, platform: process.platform },
    ingestLib: async () => ({
      ...ingestRuntime,
      walk(root, options) {
        counters.walk += 1;
        return ingestRuntime.walk(root, options);
      },
      async prepare(file, options) {
        counters.prepare += 1;
        return ingestRuntime.prepare(file, options);
      },
    }),
  };
}

async function attempt(f, flags, { manifest = f.manifest } = {}) {
  const counters = { walk: 0, prepare: 0 };
  const before = readFileSync(f.statePath);
  let value = null;
  let error = null;
  try {
    value = await cmdIngestLocal(manifest, f.manifestPath, { ...flags, "dry-run": true }, ingestOptions(f, counters));
  } catch (caught) {
    error = caught;
  }
  return { value, error, counters, stateUnchanged: before.equals(readFileSync(f.statePath)) };
}

function assertRefusal(result, variant, { walk = 0 } = {}) {
  assert.equal(result.error?.reason, `LOCAL_FOLDER_RETIRED:${variant}`);
  assert.equal(result.error?.code, "INPUT_REFUSED");
  assert.equal(supportErrorCode(result.error, { command: "ingest" }), "INPUT_REFUSED");
  assert.match(result.error?.message || "", /This folder was retired from your Brain on 2026-09-28T16:36:00\.000Z/);
  assert.match(result.error?.message || "", /Nothing was read, sent or removed/);
  assert.equal(result.counters.walk, walk);
  assert.equal(result.counters.prepare, 0);
  assert.equal(result.stateUnchanged, true);
}

function activeControl(f) {
  const value = structuredClone(f.manifest);
  value.corpora.local_folder = {
    enabled: true,
    path: f.retiredPath,
    source: "documents",
  };
  return value;
}

try {
  {
    const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8"));
    const corpora = schema.properties.corpora.properties;
    assert.deepEqual(
      Object.keys(corpora.local_folder.properties).filter((key) => key.startsWith("retired_")),
      ["retired_at", "retired_path", "retired_source", "retired_identity", "retired_by"],
    );
    assert.equal(corpora.upload.properties.retired_at.format, "date-time");
    assert.notEqual(corpora.local_folder.additionalProperties, false);
    assert.notEqual(corpora.upload.additionalProperties, false);
  }

  {
    const f = fixture();
    assert.deepEqual(retiredLocalFolderOf(f.manifest), f.manifest.corpora.local_folder);
    assert.equal(retiredLocalFolderOf(activeControl(f)), null);
    assert.equal(retiredLocalFolderOf({ corpora: { local_folder: { retired_at: "" } } }), null);

    const explicit = await attempt(f, { path: f.retiredPath, source: "documents" });
    assertRefusal(explicit, "retired_source");
    const explicitControl = await attempt(f, { path: f.retiredPath, source: "documents" }, { manifest: activeControl(f) });
    assert.ifError(explicitControl.error);
    assert.equal(explicitControl.counters.walk, 1, "the non-retired control reaches the real walker");
    assert.ok(explicitControl.value.would_send >= 1);

    const bare = await attempt(f, { path: f.retiredPath });
    assertRefusal(bare, "bare_path_after_retirement");
    assert.match(bare.error.message, /name the source/i);
    const bareControl = await attempt(f, { path: f.retiredPath }, { manifest: activeControl(f) });
    assert.ifError(bareControl.error);
    assert.equal(bareControl.counters.walk, 1);

    assertRefusal(await attempt(f, { path: f.unrelated, source: "documents" }), "retired_source");
    assertRefusal(await attempt(f, { path: f.retiredPath, source: "documents", reset: true, "approve-removals": "a".repeat(64) }), "retired_source");
  }

  {
    const f = fixture();
    const subfolder = join(f.retiredPath, "A");
    assertRefusal(await attempt(f, { path: subfolder, source: "other" }), "inside_retired");

    const alias = join(f.base, "retired-alias");
    symlinkSync(f.retiredPath, alias, process.platform === "win32" ? "junction" : "dir");
    assertRefusal(await attempt(f, { path: alias, source: "other" }), "inside_retired");

    const parent = dirname(f.retiredPath);
    assertRefusal(await attempt(f, { path: parent, source: "other" }), "contains_retired");
  }

  {
    const f = fixture();
    const probe = join(f.base, "case-probe-a");
    mkdirSync(probe);
    const alternateProbe = join(f.base, "CASE-PROBE-A");
    const caseInsensitive = existsSync(alternateProbe);
    if (caseInsensitive) {
      const variant = f.retiredPath.replace("Retired Folder", "RETIRED FOLDER");
      assertRefusal(await attempt(f, { path: variant, source: "other" }), "inside_retired");
    } else {
      const different = join(f.base, "RETIRED FOLDER");
      mkdirSync(different);
      writeFileSync(join(different, "control.txt"), "synthetic case-sensitive control text with enough words\n");
      const control = await attempt(f, { path: different, source: "other" });
      assert.ifError(control.error);
      assert.equal(control.counters.walk, 1, "case-sensitive runners prove the spelling is a different folder");
    }
  }

  {
    const f = fixture();
    const movedParent = join(f.base, "Container");
    const moved = join(movedParent, "Moved Retired Folder");
    mkdirSync(movedParent);
    renameSync(f.retiredPath, moved);
    const result = await attempt(f, { path: movedParent, source: "other" });
    assertRefusal(result, "contains_retired", { walk: 1 });
  }

  {
    const f = fixture();
    const allowed = await attempt(f, { path: f.unrelated, source: "reports" });
    assert.ifError(allowed.error);
    assert.equal(allowed.counters.walk, 1);
    assert.ok(allowed.value.would_send >= 1, "a new named source reaches document preparation");
  }

  {
    const f = fixture({ retiredBy: "settings-step folder-off" });
    assert.equal(f.manifest.corpora.local_folder.retired_by, "settings-step folder-off");
    assertRefusal(await attempt(f, { path: f.retiredPath, source: "documents" }), "retired_source");
  }

  {
    const f = fixture({ uploadEnabled: true });
    let calendarRuns = 0;
    let uploadReason = null;
    const counters = { walk: 0, prepare: 0 };
    const lines = [];
    const loadError = await cmdLoad(f.manifestPath, {
      flags: { "dry-run": true },
      commands: {
        ingestLocal: async (m, path, flags) => {
          try {
            return await cmdIngestLocal(m, path, flags, ingestOptions(f, counters));
          } catch (error) {
            uploadReason = error.reason;
            throw error;
          }
        },
        ingestCalendar: async () => { calendarRuns++; return { dry_run: true, would_send: 1, skipped: 0 }; },
      },
      probes: { calendar: async () => ({ connected: true }) },
      log: (line) => lines.push(String(line)),
    }).then(() => null, (error) => error);
    assert.match(loadError?.message || "", /1 of 2 source\(s\) could not even be previewed/);
    assert.equal(uploadReason, "LOCAL_FOLDER_RETIRED:retired_source");
    assert.match(lines.join("\n"), /Folders on this machine[\s\S]*retired from your Brain/);
    assert.equal(calendarRuns, 1, "another load leg still reaches its decision point");
    assert.equal(counters.walk, 0);

    const disabled = structuredClone(f.manifest);
    disabled.corpora.upload.enabled = false;
    writeFileSync(f.manifestPath, manifestBytes(disabled));
    const skipped = await cmdLoad(f.manifestPath, {
      flags: { "dry-run": true },
      commands: {
        ingestLocal: () => { throw new Error("disabled upload must not run"); },
        ingestCalendar: async () => ({ dry_run: true, would_send: 1, skipped: 0 }),
      },
      probes: { calendar: async () => ({ connected: true }) },
      log: () => {},
    });
    assert.equal(skipped.entries.find((entry) => entry.key === "upload").status, "skipped");
  }

  {
    const f = fixture();
    const seen = [];
    const context = {
      manifest: f.manifest,
      absoluteManifest: f.manifestPath,
      plan: { source: { id: "documents", kind: "upload" } },
    };
    const result = await runApprovedProvenanceRewalk(context, { "approve-removals": "b".repeat(64) }, {
      ingestLocal: (m, path, flags) => {
        seen.push({ m, path, flags });
        return cmdIngestLocal(m, path, { ...flags, "dry-run": true }, ingestOptions(f, { walk: 0, prepare: 0 }));
      },
    }).then(() => null, (error) => error);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].flags, {
      source: "documents",
      reset: true,
      "approve-removals": "b".repeat(64),
      path: f.retiredPath,
    });
    assert.equal(result?.reason, "LOCAL_FOLDER_RETIRED:retired_source");

    const readiness = await inspectProvenanceRepairReadiness({
      m: f.manifest,
      manifestPath: f.manifestPath,
      source: "documents",
      kind: "upload",
      options: {
        statusFolderScheduler: async () => ({ installed: false, loaded: false, running: false, definitionMatches: false, interpreterPresent: true }),
      },
    });
    assert.ok(readiness.readiness.blockers.includes("corpora.local_folder is retired in this manifest"));
  }

  {
    const f = fixture();
    const retiredButEnabled = structuredClone(f.manifest);
    retiredButEnabled.corpora.local_folder.enabled = true;
    let pathInspections = 0;
    let schedulerReads = 0;
    const refused = await inspectProvenanceRepairReadiness({
      m: retiredButEnabled,
      manifestPath: f.manifestPath,
      source: "documents",
      kind: "upload",
      options: {
        platform: "darwin",
        inspectLocalPath: (...args) => { pathInspections += 1; return statSync(...args); },
        readSchedulerStatus: () => {
          schedulerReads += 1;
          return { installed: false, loaded: false, running: false };
        },
      },
    });
    assert.ok(refused.readiness.blockers.some((blocker) => /retired/i.test(blocker)));
    assert.equal(pathInspections, 0,
      "retired repair readiness reaches its retirement decision before local inspection");
    assert.equal(schedulerReads, 0,
      "retired repair readiness reaches no scheduler or install boundary");

    const active = activeControl(f);
    let controlInspections = 0;
    const allowed = await inspectProvenanceRepairReadiness({
      m: active,
      manifestPath: f.manifestPath,
      source: "documents",
      kind: "upload",
      options: {
        platform: "linux",
        inspectLocalPath: (...args) => { controlInspections += 1; return statSync(...args); },
      },
    });
    assert.equal(controlInspections, 1,
      "the non-retired repair control reaches local inspection once");
    assert.equal(allowed.readiness.blockers.length, 0);
  }

  {
    const f = fixture();
    const retiredButEnabled = structuredClone(f.manifest);
    retiredButEnabled.corpora.local_folder.enabled = true;
    let assessCalls = 0;
    const assessmentLib = {
      parseProvenanceSourceAssessmentArgv: () => ({ manifest: f.manifestPath, source: "documents", targets: ["fixture.txt"] }),
      provenanceSourceAssessmentFailureReceipt: (code) => ({ status: "failed", code }),
      assessLocalProvenanceSource: async () => { assessCalls++; return { ok: true }; },
      publicProvenanceSourceAssessmentResult: () => ({ status: "complete", assessment_complete: true }),
    };
    const refused = await cmdProvenanceAssess([], {
      assessmentLib,
      pinManifest: () => ({ manifest: retiredButEnabled }),
      pinRoot: () => ({ path: f.retiredPath }),
      revalidateRoot: () => {},
    }).then(() => null, (error) => error);
    assert.equal(JSON.parse(refused.message).code, "MANIFEST_POLICY_INVALID");
    assert.equal(assessCalls, 0,
      "the retired provenance assessment reaches its policy decision before the folder assessment");

    const active = activeControl(f);
    const allowed = await cmdProvenanceAssess([], {
      assessmentLib,
      pinManifest: () => ({ manifest: active }),
      pinRoot: () => ({ path: f.retiredPath }),
      revalidateRoot: () => {},
      assess: async () => { assessCalls++; return { ok: true }; },
    });
    assert.equal(allowed.status, "complete");
    assert.equal(assessCalls, 1, "the enabled control reaches assessment");
  }

  {
    const f = fixture();
    const calls = [];
    const result = await attempt(f, { path: f.unrelated, source: "reports" });
    assert.ifError(result.error);
    const lockControl = await cmdIngestLocal(activeControl(f), f.manifestPath, {
      path: f.retiredPath,
      source: "documents",
      "dry-run": true,
    }, {
      ...ingestOptions(f, { walk: 0, prepare: 0 }),
      withSourceIngestLock: async (_options, task) => {
        calls.push("lease");
        return task({ assertOwned: () => true });
      },
    });
    assert.equal(calls.length, 1, "a local dry run now holds the reader lease that folder off probes");
    assert.equal(lockControl.dry_run, true);
  }

  {
    const f = fixture();
    let ingestCalls = 0;
    let rememberCalls = 0;
    const output = [];
    const result = await completeSetupFolderStep({
      manifest: f.manifest,
      manifestPath: f.manifestPath,
      folder: f.retiredPath,
      shownManifestPath: f.manifestPath,
      ingest: async () => { ingestCalls++; throw new Error("retired setup must not walk"); },
      remember: () => { rememberCalls++; },
      log: (line) => output.push(String(line)),
    });
    assert.equal(result.skippedRetiredFolder, true);
    assert.equal(ingestCalls, 0);
    assert.equal(rememberCalls, 1, "setup still remembers the installed manifest after the retired-folder skip");
    assert.match(output.join("\n"), /watched folder was turned off on 2026-09-28T16:36:00\.000Z/);
    assert.match(output.join("\n"), /--source <a new name>/);
  }

  console.log("retired folder guard: PASS");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
