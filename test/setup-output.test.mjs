import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { cmdSetup, displayPathForTesting, successMark } from "../brain.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, "");
const shown = (value) => renderCliCommands(value);

// All external stages and credential storage are fixtures. Any accidental
// network fallback fails here instead of consulting a real owner install.
async function runSetup({ flags = {}, checks = [], wired = ["Claude Code", "Codex"], failWiring = false, guideStatus = "written", folder = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "setup-output-"));
  const target = join(root, "owner-brain", "brain.manifest.json");
  const keyFile = join(root, "fixture-admin-key");
  writeFileSync(keyFile, ["fixture", "setup", "value"].join("-"), { mode: 0o600 });
  const events = [];
  const lines = [];
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  console.log = (...values) => lines.push(strip(values.join(" ")));
  globalThis.fetch = async () => { throw new Error("setup output fixture must remain offline"); };
  let failure;
  try {
    await cmdSetup(target, {
      flags: { name: "Owner Brain", slug: "owner-brain", ...flags },
      platform: "linux",
      sessionFolder: root,
      doctorRunAll: async () => { events.push("preflight"); return checks; },
      listCloudflareAccounts: async () => [{ id: "a".repeat(32), name: "Owner account" }],
      ask: async (question, fallback) => /folder to load/i.test(question) ? folder : fallback,
      configureStandardAdminKeyStorage: () => ({ changed: false }),
      prepareSetupAdminKey: async () => ({ source: "generated", value: readFileSync(keyFile, "utf8"), plan: { backend: "file", path: keyFile } }),
      cmdVerify: async () => { events.push("verify"); },
      cmdProvision: async () => { events.push("provision"); },
      setupWorkerScriptExists: async () => false,
      cmdMigrate: async () => { events.push("migrate"); },
      cmdDeploy: async () => { events.push("deploy"); },
      cmdSecrets: async () => { events.push("secrets"); },
      cmdDrain: async () => { events.push("drain"); },
      cmdHealth: async () => { events.push("health"); },
      wireAgents: async () => {
        events.push("wire");
        return { wired: failWiring ? [] : wired, failures: failWiring ? ["Claude Code"] : [] };
      },
      writeClaudeWorkspaceGuide: () => { events.push("claude-guide"); return { status: guideStatus, path: join(root, "owner-brain", "CLAUDE.md") }; },
      writeCodexWorkspaceGuide: () => { events.push("codex-guide"); return { status: guideStatus, path: join(root, "owner-brain", "AGENTS.md") }; },
      cmdIngest: async () => { events.push("ingest"); },
      rememberInstalledManifest: () => { events.push("remember"); },
      backlogCount: async () => { events.push("backlog"); return 0; },
    });
  } catch (error) { failure = error; }
  finally { console.log = originalLog; globalThis.fetch = originalFetch; }
  const manifest = (() => { try { return JSON.parse(readFileSync(target, "utf8")); } catch { return null; } })();
  rmSync(root, { recursive: true, force: true });
  return { output: lines.join("\n"), events, failure, target, root, manifest };
}

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
  assert.match(fresh.output.trimEnd(), /✓    Connected to Codex$/);
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
