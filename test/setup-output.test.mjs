import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { cmdSetup, completeSetupFolderStep, displayPathForTesting, successMark } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { setupSettingsProofFixture } from "./helpers/setup-settings-proof-fixture.mjs";

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, "");
const shown = (value) => renderCliCommands(value);

// All external stages and credential storage are fixtures. Any accidental
// network fallback fails here instead of consulting a real owner install.
async function runSetup({ flags = {}, checks = [], wired = ["Claude Code", "Codex"], failWiring = false, guideStatus = "written", folder = "", existingManifest = null, corpus = { documents: 0 }, documentsPerLoad = 3, loadResult = null, ingestFailure = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "setup-output-"));
  const target = join(root, "owner-brain", "brain.manifest.json");
  if (existingManifest) {
    mkdirSync(join(root, "owner-brain"));
    writeFileSync(target, JSON.stringify(existingManifest));
  }
  const keyFile = join(root, "fixture-admin-key");
  writeFileSync(keyFile, ["fixture", "setup", "value"].join("-"), { mode: 0o600 });
  const events = [];
  const lines = [];
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  console.log = (...values) => lines.push(strip(values.join(" ")));
  globalThis.fetch = async () => { throw new Error("setup output fixture must remain offline"); };
  const proof = existingManifest ? setupSettingsProofFixture(target, {
    account: { id: "a".repeat(32), name: "Owner account" },
    version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version,
    writerProtocol: "lease-v1",
  }) : null;
  let failure;
  try {
    await cmdSetup(target, {
      ...(proof?.options || {}),
      flags: { name: "Owner Brain", slug: "owner-brain", ...flags },
      platform: "linux",
      sessionFolder: root,
      doctorRunAll: async () => { events.push("preflight"); return checks; },
      listCloudflareAccounts: async () => [{ id: "a".repeat(32), name: "Owner account" }],
      ask: async (question, fallback) => /folder to load/i.test(question) ? folder : fallback,
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "generated", value: readFileSync(keyFile, "utf8"), plan: { backend: "file", path: keyFile } }),
      cmdVerify: async () => { events.push("verify"); },
      cmdProvision: async path => {
        events.push("provision");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.infrastructure.cloudflare.d1_database_id = "11111111-2222-4333-8444-555555555555";
        writeFileSync(path, JSON.stringify(manifest));
      },
      setupWorkerScriptExists: async () => !!existingManifest,
      resolveExistingWorkerProbeDomain: async () => "fixture.invalid",
      probeExistingWorkerHealth: async () => {
        events.push("existing-worker-health");
        return { version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version };
      },
      cmdMigrate: async () => { events.push("migrate"); },
      cmdDeploy: async () => { events.push("deploy"); },
      cmdSecrets: async () => { events.push("secrets"); },
      cmdDrain: async () => { events.push("drain"); },
      cmdHealth: async () => {
        events.push("health");
        if (existingManifest) events.push(`retained-documents:${corpus.documents}`);
      },
      wireAgents: async () => {
        events.push("wire");
        return { wired: failWiring ? [] : wired, failures: failWiring ? ["Claude Code"] : [] };
      },
      writeClaudeWorkspaceGuide: () => { events.push("claude-guide"); return { status: guideStatus, path: join(root, "owner-brain", "CLAUDE.md") }; },
      writeCodexWorkspaceGuide: () => { events.push("codex-guide"); return { status: guideStatus, path: join(root, "owner-brain", "AGENTS.md") }; },
      cmdIngest: async () => {
        events.push("ingest");
        if (ingestFailure) throw ingestFailure;
        corpus.documents += documentsPerLoad;
        return loadResult ?? { created: documentsPerLoad, updated: 0, unchanged: 0 };
      },
      rememberInstalledManifest: () => { events.push("remember"); },
      backlogCount: async () => { events.push("backlog"); return 0; },
    });
    if (proof) proof.assertReads();
  } catch (error) { failure = error; }
  finally { console.log = originalLog; globalThis.fetch = originalFetch; }
  const manifest = (() => { try { return JSON.parse(readFileSync(target, "utf8")); } catch { return null; } })();
  rmSync(root, { recursive: true, force: true });
  return { output: lines.join("\n"), events, failure, target, root, manifest };
}

const approvedEmptyFinish = "Your Brain is running. So far it holds only a small test note, so it can't answer questions about your business yet. Next, we'll connect Google or load one folder.";
const readingFinish = "Your Brain is running and reading your files. You can ask questions once it finishes.";
const resumedFinish = "Your Brain is running. You can connect a source or load a folder later.";
const finishLine = (output) => output.split("\n").map(line => line.trim()).find(line => line.startsWith("Your Brain is running"));

const fresh = await runSetup();
test("CONTROL: the real setup reaches every stage in its original order and saves the manifest", () => {
  assert.ifError(fresh.failure);
  assert.deepEqual(fresh.events, ["preflight", "verify", "provision", "migrate", "deploy", "secrets", "drain", "health", "wire", "claude-guide", "codex-guide", "remember", "backlog"]);
  assert.equal(fresh.manifest.client.slug, "owner-brain");
  assert.equal(fresh.manifest.infrastructure.cloudflare.account_id, "a".repeat(32));
});
test("every setup heading uses STEP n of 6 with the long wait announced first", () => {
  const headings = [...fresh.output.matchAll(/^  STEP \d of 6 · .+$/gm)].map(([line]) => line);
  assert.equal(headings.length, 6);
  assert.match(headings[2], /^  STEP 3 of 6 · creating your Brain · about 3 min$/);
  assert.match(headings[5], /^  STEP 6 of 6 · your first files/);
});
test("completed steps have one done line each", () => {
  for (let step = 1; step <= 6; step++) {
    assert.equal(fresh.output.split("\n").filter((line) => line.startsWith(`  ✅ STEP ${step} of 6 done: `)).length, 1);
  }
});
test("the setup file uses the display path and the account confirmation shows its name", () => {
  assert.match(fresh.output, /  ✓    Setup file saved: /);
  assert.ok(fresh.output.includes(`Setup file saved: ${displayPathForTesting(fresh.target, process.cwd())}`));
  assert.ok(fresh.output.includes('Cloudflare account "Owner account"'));
  assert.equal(fresh.output.includes("a".repeat(32)), false);
});
test("key and answer copy uses owner words", () => {
  assert.ok(fresh.output.includes("✓    Brain key saved on this computer"));
  assert.ok(fresh.output.includes("Answers: built-in model for now. Next we can switch to Claude (recommended)."));
});
test("a shared Brain folder is shown once for both clients", () => {
  assert.equal(fresh.events.filter((event) => event.endsWith("-guide")).length, 2);
  assert.equal(fresh.output.split("\n").filter((line) => /Your Brain folder:/.test(line)).length, 1);
  const folder = displayPathForTesting(join(fresh.root, "owner-brain"), process.cwd());
  assert.equal(fresh.output.split("\n").filter((line) => line.includes(folder) && !line.includes("brain.manifest.json")).length, 1);
  assert.ok(fresh.output.includes("✓    Connected to Claude Code"));
  assert.ok(fresh.output.includes("Restart Claude Code, then ask a question."));
});
test("normal owner output ends in a truthful check summary without the probe notice", () => {
  assert.ok(fresh.events.includes("backlog"), "the finish decision was reached");
  assert.doesNotMatch(fresh.output, /regression questions|adaptive acceptance|query-visible/);
  assert.ok(fresh.output.includes(approvedEmptyFinish));
  assert.match(fresh.output.trimEnd(), /✓    Connected to Codex$/);
});
test("finish contract: no folder keeps the exact approved sentence", () => {
  assert.ifError(fresh.failure);
  assert.deepEqual(fresh.events.slice(-2), ["remember", "backlog"], "the finish decision must be reached without ingest");
  assert.equal(finishLine(fresh.output), approvedEmptyFinish);
});

test("finish contract: missing folder keeps the exact approved sentence", async () => {
  const run = await runSetup({ folder: "C:\\does-not-exist" });
  assert.ifError(run.failure);
  assert.deepEqual(run.events.slice(-2), ["remember", "backlog"], "the missing-folder branch must reach the finish without ingest");
  assert.match(run.output, /That folder was not found, so nothing was loaded/);
  assert.equal(finishLine(run.output), approvedEmptyFinish);
});

for (const loadResult of [
  { created: 3, updated: 0, unchanged: 0 },
  { created: 0, updated: 3, unchanged: 0 },
  { created: 0, updated: 0, unchanged: 3 },
  { created: 0, updated: 0, unchanged: 0 },
]) {
  const loaded = Object.values(loadResult).some(count => count > 0);
  test(`finish contract: completed load ${JSON.stringify(loadResult)} follows its receipt`, async () => {
    const folder = mkdtempSync(join(tmpdir(), "setup-finish-control-"));
    try {
      const run = await runSetup({ folder, documentsPerLoad: loaded ? 3 : 0, loadResult });
      assert.ifError(run.failure);
      assert.deepEqual(run.events.slice(-3), ["remember", "ingest", "backlog"], "the real load and finish decisions must both be reached");
      assert.equal(finishLine(run.output), loaded ? readingFinish : approvedEmptyFinish);
      if (loaded) {
        assert.doesNotMatch(finishLine(run.output), /ask (?:a question|questions) now|answer (?:a question|questions) now/i);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
}

test("finish contract: interrupted ingest reaches the loader without a success finish", async () => {
  const folder = mkdtempSync(join(tmpdir(), "setup-finish-failure-"));
  try {
    const ingestFailure = new Error("fixture load interrupted");
    const run = await runSetup({ folder, ingestFailure });
    assert.equal(run.failure, ingestFailure);
    assert.deepEqual(run.events.slice(-2), ["remember", "ingest"], "the throwing loader must be reached");
    assert.equal(finishLine(run.output), undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("success glyph is a check on and off a TTY", () => {
  assert.equal(successMark(false), "✓");
  assert.equal(strip(successMark(true)), "✓");
});
test("verbose retains technician detail as one notice", async () => {
  const run = await runSetup({ flags: { verbose: true } });
  assert.ifError(run.failure);
  assert.ok(run.events.includes("backlog"));
  assert.equal(run.output.split("\n").filter((line) => /regression questions/.test(line)).length, 1);
  assert.match(run.output, /regression questions[^\n]*query-visible/);
});
const failedChecks = [
  { name: "Node.js", status: "ok", detail: "ready" },
  { name: "Free space", status: "warn", detail: "check space", fix: "Make room for files." },
  { name: "Claude Code", status: "fail", detail: "not signed in", fix: "Open Claude Code once and sign in." },
];
test("machine check says Needs you with the fix underneath, without the init hint", async () => {
  const run = await runSetup({ checks: failedChecks });
  assert.deepEqual(run.events, ["preflight"], "the failing check was reached before any later stage");
  assert.ok(run.failure);
  assert.match(run.output, /  ✓    Node.js/);
  assert.match(run.output, /  !    Free space[^\n]*\n    Make room for files\./);
  assert.match(run.output, /  ✗    Claude Code · Needs you[^\n]*\n    Open Claude Code once and sign in\./);
  assert.doesNotMatch(run.output, /FAIL/);
  assert.doesNotMatch(run.failure.message, /manifest|brain init|token/);
});
test("verbose preserves the first-run init hint without running later stages", async () => {
  const run = await runSetup({ checks: failedChecks, flags: { verbose: true } });
  assert.deepEqual(run.events, ["preflight"]);
  assert.ok(run.failure);
  assert.ok(run.failure.message.includes(shown("brain init <path>")));
});
test("warnings without an owner action stay in verbose output", async () => {
  const checks = [{ name: "Free disk space", status: "warn", detail: "3.1 GiB free" }];
  const owner = await runSetup({ checks });
  assert.ifError(owner.failure);
  assert.ok(owner.events.includes("backlog"), "setup reached the finish with this warning");
  assert.doesNotMatch(owner.output, /Free disk space/);
  const technician = await runSetup({ checks, flags: { verbose: true } });
  assert.ifError(technician.failure);
  assert.ok(technician.events.includes("backlog"));
  assert.match(technician.output, /  !    Free disk space · 3.1 GiB free/);
});
test("CONTROL: setup still rejects unsupported JSON before entering preflight", async () => {
  const run = await runSetup({ flags: { json: true } });
  assert.ok(run.failure);
  assert.match(run.failure.message, /unknown option --json/);
  assert.deepEqual(run.events, []);
});
test("CONTROL: failed wiring reaches the decision and never claims setup is done", async () => {
  const run = await runSetup({ failWiring: true });
  assert.ok(run.failure);
  assert.ok(run.events.includes("wire"));
  assert.equal(run.events.includes("remember"), false);
  assert.doesNotMatch(run.output, /✅ STEP 5 of 6 done:|✓    Connected to Claude Code/);
});
test("skipped connections never appear as connected in the finish summary", async () => {
  const run = await runSetup({ flags: { "no-connect": true } });
  assert.ifError(run.failure);
  assert.ok(run.events.includes("remember"));
  assert.match(run.output, /✅ STEP 5 of 6 done: skipped on this computer/);
  assert.doesNotMatch(run.output, /✓    Connected to/);
});
test("a preserved damaged guide keeps its warning without claiming its rules are ready", async () => {
  const run = await runSetup({ guideStatus: "preserved_damaged_section" });
  assert.ifError(run.failure);
  assert.equal(run.events.filter((event) => event.endsWith("-guide")).length, 2);
  assert.match(run.output, /damaged/);
  assert.doesNotMatch(run.output, /Your Brain folder:/);
});

test("a missing Windows folder warns, remembers once and resolves without loading", async () => {
  const events = [];
  const lines = [];
  await assert.doesNotReject(completeSetupFolderStep({
    manifest: {},
    manifestPath: "brain.manifest.json",
    folder: "C:\\does-not-exist",
    platform: "win32",
    remember: () => events.push("remember"),
    ingest: async () => events.push("ingest"),
    log: (line) => { events.push("warning"); lines.push(strip(line)); },
  }), "a missing optional folder must not stop a finished Brain");
  assert.deepEqual(events, ["remember", "warning"], "the missing-folder decision was reached after remembering, with no ingest");
  assert.deepEqual(lines, ["That folder was not found, so nothing was loaded. Your Brain is ready; you can load a folder later."]);
});

test("an ingest failure preserves the remembered install and still reports the failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "setup-folder-failure-"));
  const events = [];
  const loadFailure = new Error("fixture folder load interrupted");
  try {
    await assert.rejects(completeSetupFolderStep({
      manifest: {},
      manifestPath: join(root, "brain.manifest.json"),
      folder: root,
      remember: () => events.push("remember"),
      ingest: async () => { events.push("ingest"); throw loadFailure; },
      log: () => events.push("log"),
    }), (error) => error === loadFailure, "a real ingest failure must remain visible");
    assert.deepEqual(events, ["remember", "ingest"], "remember must run once before the throwing ingest decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTROL: an existing folder still loads once after remembering", async () => {
  const root = mkdtempSync(join(tmpdir(), "setup-folder-control-"));
  const events = [];
  try {
    const result = await completeSetupFolderStep({
      manifest: {},
      manifestPath: join(root, "brain.manifest.json"),
      folder: root,
      remember: () => events.push("remember"),
      ingest: async () => events.push("ingest"),
      log: () => events.push("log"),
    });
    assert.deepEqual(events, ["remember", "ingest"]);
    assert.deepEqual(result, { skippedRetiredFolder: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mistyped folder reaches the real setup finish screen without claiming files loaded", async () => {
  const run = await runSetup({ folder: "C:\\does-not-exist" });
  assert.ifError(run.failure);
  assert.deepEqual(run.events.slice(-2), ["remember", "backlog"], "the finish decision was reached without ingest");
  assert.equal(run.events.filter((event) => event === "remember").length, 1);
  assert.match(run.output, /That folder was not found, so nothing was loaded\. Your Brain is ready; you can load a folder later\./);
  assert.match(run.output, /✅ STEP 6 of 6 done: first files step complete/);
  assert.match(run.output, /✓    Brain setup complete/);
});

// Exercise a completed install and its retry through cmdSetup, keeping the
// synthetic corpus separate from the saved manifest, as real storage is.
for (const documents of [1, 3, 1250]) {
  test(`a missing folder on a resumed Brain preserves truthful finish copy with ${documents} retained documents`, async () => {
    const corpus = { documents: 0 };
    const folder = mkdtempSync(join(tmpdir(), "setup-populated-control-"));
    let seeded;
    try {
      seeded = await runSetup({ folder, corpus, documentsPerLoad: documents });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    assert.ifError(seeded.failure);
    assert.equal(seeded.events.filter((event) => event === "ingest").length, 1,
      "the existing-folder control must reach the ingest seam");
    assert.equal(corpus.documents, documents);
    const saved = structuredClone(seeded.manifest);
    saved.brain.domain = "fixture.invalid";
    const resumed = await runSetup({ existingManifest: saved, corpus, folder: "C:\\does-not-exist" });
    assert.ifError(resumed.failure);
    assert.ok(resumed.events.includes("existing-worker-health"), "the live-install decision must be reached");
    assert.ok(resumed.events.includes(`retained-documents:${documents}`), "health must observe the retained corpus");
    assert.match(resumed.output, /already installed and live/);
    assert.equal(resumed.events.includes("migrate"), false);
    assert.equal(resumed.events.includes("deploy"), false);
    assert.equal(resumed.events.includes("ingest"), false);
    assert.equal(corpus.documents, documents, "the missing-folder retry must leave the corpus intact");
    assert.deepEqual(resumed.events.slice(-2), ["remember", "backlog"]);
    assert.match(resumed.output, /That folder was not found, so nothing was loaded/);
    assert.match(resumed.output, /Brain setup complete/);
    assert.doesNotMatch(resumed.output, /holds only a small test note|can't answer questions about your business/,
      "a finished Brain with retained documents must not be called test-only or unable to answer");
    assert.ok(resumed.output.includes(resumedFinish));
  });
}

test("a populated retry with a native missing path finishes without guessing what the Brain contains", async () => {
  const corpus = { documents: 0 };
  const root = mkdtempSync(join(tmpdir(), "setup-resume-honesty-"));
  try {
    const seed = await runSetup({ folder: root, corpus });
    assert.ifError(seed.failure);
    assert.equal(seed.events.filter((event) => event === "ingest").length, 1,
      "the successful folder control must reach the load seam");
    assert.equal(corpus.documents, 3);
    const saved = structuredClone(seed.manifest);
    saved.brain.domain = "fixture.invalid";
    const retry = await runSetup({ existingManifest: saved, corpus, folder: join(root, "missing folder") });
    assert.ifError(retry.failure);
    assert.ok(retry.events.includes("existing-worker-health"), "the existing-install decision must be reached");
    assert.ok(retry.events.includes("retained-documents:3"), "health must observe the populated corpus");
    assert.match(retry.output, /already installed and live/);
    assert.equal(retry.events.includes("migrate"), false);
    assert.equal(retry.events.includes("deploy"), false);
    assert.equal(retry.events.includes("ingest"), false);
    assert.equal(corpus.documents, 3);
    assert.deepEqual(retry.events.slice(-2), ["remember", "backlog"]);
    assert.match(retry.output, /That folder was not found, so nothing was loaded/);
    assert.match(retry.output, /Brain setup complete/);
    assert.doesNotMatch(retry.output, /holds only a small test note|can't answer questions about your business/,
      "the finish screen has no evidence for a test-only corpus or inability to answer");
    assert.ok(retry.output.includes(resumedFinish));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
