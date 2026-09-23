/**
 * A moved or copied brain folder is this owner's own brain at a new address.
 *
 * Nothing pinned either case before. The registration predicate compares the
 * BRAIN_MANIFEST locator as a string and never reads the path, so copying a
 * folder and leaving the original perfectly readable reproduced the same
 * refusal as moving it. Both cases are pinned here, as separate tests, so one
 * failure cannot hide the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  cmdAssistantRepair,
  cmdMcpConfig,
  mcpRegistrationDescriptor,
  mcpRegistrationIsExact,
  mcpRegistrationIsInstallerOwned,
  mcpRegistrationRelocatedManifest,
  wireAgents,
} from "../brain.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-moved-folder-"));
let caseCount = 0;
function nextRoot() {
  const root = join(sandbox, `case-${++caseCount}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

const MANIFEST = Object.freeze({
  client: { slug: "fixture-brain", display_name: "Fixture Owner" },
  brain: { version: "0.4.8", domain: "fixture.invalid", worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { account_id: "fixture-account" } },
  operations: { admin_key_secret: "keychain://fixture-brain-admin/owner" },
});
const BASE_URL = "https://fixture.invalid";

function writeManifest(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "brain.manifest.json");
  writeFileSync(path, `${JSON.stringify(MANIFEST, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * The registration the installer wrote before the folder changed address, and
 * the descriptor it wants afterwards.
 *
 * The installed CLI does not move with the brain folder, so the runtime path in
 * args is identical on both sides and BRAIN_MANIFEST is the only field that
 * differs. That is the whole defect.
 */
function relocatedBrain({ keepOriginal }) {
  const root = nextRoot();
  const oldManifest = writeManifest(join(root, "Old Place", "Brain"));
  const newManifest = writeManifest(join(root, "New Place", "Brain"));
  const before = mcpRegistrationDescriptor(MANIFEST, oldManifest, { baseUrl: BASE_URL });
  const desired = mcpRegistrationDescriptor(MANIFEST, newManifest, { baseUrl: BASE_URL });
  if (!keepOriginal) rmSync(dirname(oldManifest), { recursive: true, force: true });
  assert.equal(
    before.args[0],
    desired.args[0],
    "the fixture moves only the brain folder, never the installed CLI",
  );
  return {
    root,
    oldManifest,
    newManifest,
    desired,
    entry: {
      type: "stdio",
      command: before.command,
      args: [...before.args],
      env: { ...before.env },
    },
  };
}

function readClaudeConfig(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function writeClaudeEntry(path, name, entry) {
  const config = readClaudeConfig(path);
  const servers = { ...(config.mcpServers || {}) };
  if (entry === null) delete servers[name];
  else servers[name] = entry;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function registrationFromArgs(args) {
  const separator = args.indexOf("--");
  const env = {};
  for (let i = 0; i < separator; i++) {
    if (args[i] !== "-e") continue;
    const assignment = String(args[++i]);
    const equals = assignment.indexOf("=");
    env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  return {
    type: "stdio",
    command: args[separator + 1],
    args: args.slice(separator + 2),
    env,
  };
}

/** Claude's CLI, reduced to the calls this defect exercises. */
function claudeOnlyCli(claudeConfigPath) {
  const calls = [];
  const done = (ok, stdout = "") => ({ ok, stdout, stderr: "", out: stdout, missing: false });
  const runCommand = (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "--version") return done(command === "claude", "fixture\n");
    if (command !== "claude") return done(false);
    if (args[1] === "remove") {
      writeClaudeEntry(claudeConfigPath, args.at(-1), null);
      return done(true, "removed\n");
    }
    if (args[1] === "add") {
      writeClaudeEntry(claudeConfigPath, args[4], registrationFromArgs(args));
      return done(true, "added\n");
    }
    if (args[1] === "add-json") {
      writeClaudeEntry(claudeConfigPath, args[4], JSON.parse(args[5]));
      return done(true, "added\n");
    }
    return done(false);
  };
  return {
    runCommand,
    calls,
    mutated: () => calls.some((call) => ["add", "add-json", "remove"].includes(call.args[1])),
  };
}

function fixtureEnvironment(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: process.env.PATH || "/usr/bin:/bin",
    USER: "fixture-user",
    USERNAME: process.env.USERNAME || "fixture-user",
    LANG: "C",
  };
}

function wireOptions(claudeConfigPath, cli, home) {
  return {
    baseUrl: BASE_URL,
    environment: fixtureEnvironment(home),
    claudeConfigPath,
    targets: ["claude-code-mcp"],
    runCommand: cli.runCommand,
    verifyMcpRuntime: () => true,
    adminKeyPersistencePlan: () => ({ fixture: true }),
    readAdminKeyDurably: () => "present-without-returning-it",
  };
}

async function captureOutput(operation) {
  const prior = console.log;
  const lines = [];
  console.log = (...parts) => lines.push(parts.map(String).join(" "));
  try {
    return { value: await operation(), output: lines.join("\n") };
  } finally {
    console.log = prior;
  }
}

/** One relocated registration wired through the brain update path. */
async function wireRelocated({ keepOriginal }) {
  const fixture = relocatedBrain({ keepOriginal });
  const home = nextRoot();
  const claudeConfigPath = join(home, ".claude.json");
  writeClaudeEntry(claudeConfigPath, fixture.desired.name, fixture.entry);
  const cli = claudeOnlyCli(claudeConfigPath);
  const run = await captureOutput(() => wireAgents(
    MANIFEST,
    fixture.newManifest,
    wireOptions(claudeConfigPath, cli, home),
  ));
  return { ...fixture, claudeConfigPath, cli, run };
}

test("a moved brain folder is this installer's own registration, not a name collision", () => {
  const { entry, desired, oldManifest } = relocatedBrain({ keepOriginal: false });
  assert.equal(existsSync(oldManifest), false, "the fixture really moved the folder");
  assert.equal(mcpRegistrationIsExact(entry, desired), false, "the locator genuinely changed");
  assert.equal(
    mcpRegistrationIsInstallerOwned(entry, desired),
    true,
    "a relocated locator is this brain reporting a new address",
  );
  assert.equal(
    mcpRegistrationRelocatedManifest(entry, desired),
    oldManifest,
    "the previous address is reported so the operator can be told both",
  );
});

test("a copied brain folder decides the same way, because existence is not the discriminator", () => {
  const { entry, desired, oldManifest } = relocatedBrain({ keepOriginal: true });
  assert.equal(
    existsSync(oldManifest),
    true,
    "a copy leaves the original readable, which is why a path test cannot decide this",
  );
  assert.equal(mcpRegistrationIsExact(entry, desired), false);
  assert.equal(
    mcpRegistrationIsInstallerOwned(entry, desired),
    true,
    "a copied folder is the same owner and the same brain as a moved one",
  );
  assert.equal(mcpRegistrationRelocatedManifest(entry, desired), oldManifest);
});

test("a registration belonging to something else is still refused", () => {
  const { entry, desired, root } = relocatedBrain({ keepOriginal: true });
  const foreignRuntime = join(root, "someone-else", "brain-mcp.mjs");

  assert.equal(mcpRegistrationIsInstallerOwned({
    type: "stdio",
    command: "node",
    args: [foreignRuntime],
    env: {
      BRAIN_URL: "https://someone-else.invalid",
      BRAIN_NAME: desired.name,
      BRAIN_MANIFEST: join(root, "someone-else", "manifest.json"),
    },
  }, desired), false, "another brain under the same slug is never claimed");

  assert.equal(mcpRegistrationIsInstallerOwned({
    ...entry,
    env: { ...entry.env, BRAIN_URL: "https://someone-else.invalid" },
  }, desired), false, "the brain URL is the identity, and relocation cannot widen past it");

  assert.equal(mcpRegistrationIsInstallerOwned({
    ...entry,
    args: [foreignRuntime],
  }, desired), false, "relocation never claims a runtime this installer did not write");

  assert.equal(mcpRegistrationIsInstallerOwned({
    ...entry,
    env: { ...entry.env, BRAIN_AGENT_PROFILE: "structured-contributor" },
  }, desired), false, "a selected non-owner profile is preserved even when the folder moved");

  assert.equal(mcpRegistrationIsInstallerOwned({
    ...entry,
    env: { ...entry.env, BRAIN_KEY: "retired-fixture-value" },
  }, desired), false, "a retired literal key is never claimed through relocation");

  assert.equal(mcpRegistrationIsInstallerOwned({
    ...entry,
    env: { ...entry.env, EXTRA_SETTING: "custom" },
  }, desired), false, "any extra environment value is still somebody's customization");

  assert.equal(mcpRegistrationRelocatedManifest({
    ...entry,
    env: { ...entry.env, BRAIN_URL: "https://someone-else.invalid" },
  }, desired), null, "the accessor never reports a move for an entry it does not own");
});

test("brain update reconciles a moved brain and names both addresses", async () => {
  const { run, cli, claudeConfigPath, desired, oldManifest, newManifest } =
    await wireRelocated({ keepOriginal: false });
  assert.deepEqual(run.value.failures, [], "a moved folder is not a failure");
  assert.deepEqual(run.value.wired, ["Claude Code"]);
  assert.equal(cli.mutated(), true, "the stale registration was actually replaced");
  assert.equal(
    mcpRegistrationIsExact(readClaudeConfig(claudeConfigPath).mcpServers[desired.name], desired),
    true,
    "the registration now points at the new location",
  );
  assert.match(run.output, /the brain folder moved/i);
  assert.ok(run.output.includes(newManifest), "the new address is named");
  assert.ok(run.output.includes(oldManifest), "the old address is named");
});

test("brain update reconciles a copied brain the same way", async () => {
  const { run, claudeConfigPath, desired, oldManifest } =
    await wireRelocated({ keepOriginal: true });
  assert.equal(existsSync(oldManifest), true, "the original folder is still there");
  assert.deepEqual(run.value.failures, []);
  assert.deepEqual(run.value.wired, ["Claude Code"]);
  assert.equal(
    mcpRegistrationIsExact(readClaudeConfig(claudeConfigPath).mcpServers[desired.name], desired),
    true,
  );
  assert.match(run.output, /the brain folder moved/i);
});

test("brain mcp-config --apply reconciles a moved brain through the same reconciler", async () => {
  const fixture = relocatedBrain({ keepOriginal: false });
  const home = nextRoot();
  const claudeConfigPath = join(home, ".claude.json");
  writeClaudeEntry(claudeConfigPath, fixture.desired.name, fixture.entry);
  const cli = claudeOnlyCli(claudeConfigPath);
  const applied = await captureOutput(() => cmdMcpConfig(fixture.newManifest, {
    flags: { apply: true },
    wireOptions: wireOptions(claudeConfigPath, cli, home),
  }));
  assert.deepEqual(applied.value.failures, []);
  assert.deepEqual(applied.value.wired, ["Claude Code"]);
  assert.equal(
    mcpRegistrationIsExact(
      readClaudeConfig(claudeConfigPath).mcpServers[fixture.desired.name],
      fixture.desired,
    ),
    true,
  );
  assert.match(applied.output, /the brain folder moved/i);
});

test("brain assistant-repair previews a moved brain as repairable and applies it", async () => {
  const fixture = relocatedBrain({ keepOriginal: true });
  const home = nextRoot();
  const claudeConfigPath = join(home, ".claude.json");
  const codexConfigPath = join(home, ".codex", "config.toml");
  writeClaudeEntry(claudeConfigPath, fixture.desired.name, fixture.entry);
  const mcpOptions = {
    environment: fixtureEnvironment(home),
    installed: { "claude-code-mcp": true, "codex-mcp": false },
    claudeConfigPath,
    codexConfigPath,
    runCommand: () => ({ ok: false, stdout: "", stderr: "", out: "", missing: true }),
    verifyRuntime: () => true,
    verifyMcpRuntime: () => true,
    adminKeyPersistencePlan: () => ({ fixture: true }),
    readAdminKeyDurably: () => "present-without-returning-it",
  };
  const preview = await captureOutput(() => cmdAssistantRepair(fixture.newManifest, {
    flags: { only: "claude-code-mcp" },
    mcpOptions,
  }));
  const item = preview.value.items.find((entry) => entry.scope === "claude-code-mcp");
  assert.equal(
    item.status,
    "repairable",
    "a moved brain is repairable here, not preserved as somebody else's entry",
  );
  assert.ok(item.write_set.length >= 1, "the repair would actually change the named setting");
  assert.ok(preview.value.write_set.length >= 1, "the plan carries a nonempty write set");
  assert.ok(
    item.detail.includes(fixture.oldManifest),
    "the preview names the previous location rather than calling it an older locator",
  );

  // The approved apply has to be able to snapshot the very entry it is allowed
  // to replace, which is the reason the rollback snapshot accepts a relocated
  // locator too. Without that it refuses its own previewed write set.
  const applied = await captureOutput(() => cmdAssistantRepair(fixture.newManifest, {
    flags: { only: "claude-code-mcp", apply: true, approve: preview.value.plan_id },
    mcpOptions,
  }));
  assert.equal(applied.value.results[0].status, "repaired");
  assert.equal(
    mcpRegistrationIsExact(
      readClaudeConfig(claudeConfigPath).mcpServers[fixture.desired.name],
      fixture.desired,
    ),
    true,
    "the applied repair points the registration at the new location",
  );
});

test("a refusal names its reason and offers a remedy that does not re-enter the reconciler", async () => {
  const { desired, newManifest, root } = relocatedBrain({ keepOriginal: true });
  const home = nextRoot();
  const claudeConfigPath = join(home, ".claude.json");
  const foreign = {
    type: "stdio",
    command: "node",
    args: [join(root, "someone-else", "brain-mcp.mjs")],
    env: {
      BRAIN_URL: "https://someone-else.invalid",
      BRAIN_NAME: desired.name,
      BRAIN_MANIFEST: join(root, "someone-else", "manifest.json"),
    },
  };
  writeClaudeEntry(claudeConfigPath, desired.name, foreign);
  const cli = claudeOnlyCli(claudeConfigPath);
  const exitCodeBefore = process.exitCode;
  const run = await captureOutput(() => wireAgents(
    MANIFEST,
    newManifest,
    wireOptions(claudeConfigPath, cli, home),
  ));

  assert.deepEqual(run.value.failures, ["Claude Code"]);
  assert.deepEqual(
    readClaudeConfig(claudeConfigPath).mcpServers[desired.name],
    foreign,
    "the unrelated server is preserved byte for byte",
  );
  assert.equal(cli.mutated(), false, "a colliding registration is never mutated");

  assert.match(
    run.output,
    /another MCP server already holds this name/i,
    "the computed reason reaches the operator instead of one generic sentence",
  );
  assert.match(
    run.output,
    /mcp-config/,
    "the printed remedy is the one command that does not re-enter this reconciler",
  );
  assert.doesNotMatch(
    run.output,
    /mcp-config[^\n]*--apply/,
    "the printed mcp-config command carries no --apply, which would re-enter this reconciler",
  );
  assert.doesNotMatch(
    run.output,
    /rerun setup/i,
    "no remedy points back at the gate that produced the warning",
  );
  assert.equal(
    process.exitCode,
    exitCodeBefore,
    "a warning does not turn a completed update into a failed one",
  );
});
