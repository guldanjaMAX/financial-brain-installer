import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildLocalAssistantRepairPlan,
  cmdAssistantRepair,
  mcpRegistrationDescriptor,
  wireAgents,
} from "../brain.mjs";
import {
  CLAUDE_TECHNICIAN_SKILL_MARKER,
  inspectTechnicianSkillEverywhere,
  installClaudeTechnicianSkill,
  repairTechnicianSkillEverywhere,
  reviewedSkillContent,
} from "../operations/claude-skill.mjs";
import {
  LOCAL_ASSISTANT_REPAIR_SCOPES,
  parseLocalAssistantRepairScopes,
} from "../operations/local-assistant-repair.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "brain-assistant-repair-"));
const manifestPath = join(sandbox, "brain.manifest.json");
const manifest = {
  client: { slug: "fixture-brain", display_name: "Fixture Owner" },
  brain: { version: "0.4.6", domain: "fixture.invalid", worker_name: "fixture-brain" },
  infrastructure: { cloudflare: { account_id: "fixture-account" } },
  operations: { admin_key_secret: "keychain://fixture-brain-admin/owner" },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

const captured = async (action) => {
  const out = [];
  const originalLog = console.log;
  try {
    console.log = (...parts) => out.push(parts.join(" "));
    const value = await action();
    return { value, output: out.join("\n") };
  } finally {
    console.log = originalLog;
  }
};

function pathInventory(root) {
  const entries = [];
  const visit = (path, relative = "") => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const label = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(child);
      if (stat.isDirectory()) {
        entries.push({ path: `${label}/`, mode: stat.mode & 0o7777 });
        visit(child, label);
      } else {
        entries.push({
          path: label,
          mode: stat.mode & 0o7777,
          bytes: readFileSync(child).toString("hex"),
        });
      }
    }
  };
  visit(root);
  return entries;
}

function writePriorInstallerRuntime(parent) {
  const packageRoot = join(parent, ".financial-brain", "lib", "node_modules", "brain-installer");
  const runtime = join(packageRoot, "components", "brain-mcp.mjs");
  mkdirSync(dirname(runtime), { recursive: true, mode: 0o700 });
  writeFileSync(
    runtime,
    readFileSync(new URL("./fixtures/published-v0.4.0-brain-mcp.mjs", import.meta.url)),
    { mode: 0o600 },
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "brain-installer", version: "0.4.0" })}\n`,
    { mode: 0o600 },
  );
  return runtime;
}

try {
  assert.deepEqual(
    parseLocalAssistantRepairScopes("codex-mcp,technician-skill"),
    ["technician-skill", "codex-mcp"],
    "scope order is canonical so one preview has one stable plan id",
  );
  assert.deepEqual(LOCAL_ASSISTANT_REPAIR_SCOPES, [
    "technician-skill",
    "claude-code-mcp",
    "codex-mcp",
  ]);
  assert.throws(() => parseLocalAssistantRepairScopes("cli"), /unsupported local repair scope/i);
  assert.throws(() => parseLocalAssistantRepairScopes("codex-mcp,codex-mcp"), /more than once/i);

  const skillHome = join(sandbox, "skill-home");
  mkdirSync(skillHome, { recursive: true, mode: 0o700 });
  const skillOptions = { home: skillHome };
  const manifestBefore = readFileSync(manifestPath);
  const firstPreview = await captured(() => cmdAssistantRepair(manifestPath, {
    flags: { only: "technician-skill" },
    skillOptions,
  }));
  assert.equal(firstPreview.value.read_only, true);
  assert.equal(firstPreview.value.mode, "preview");
  assert.equal(firstPreview.value.write_set.length, 8);
  assert.equal(firstPreview.value.transaction.scope, "complete-selected-write-set");
  assert.match(firstPreview.value.plan_id, /^[a-f0-9]{64}$/);
  assert.equal(firstPreview.value.schema_version, 2);
  assert.match(firstPreview.output, /Nothing has changed/i);
  assert.match(firstPreview.output, /Rollback:/);
  assert.match(firstPreview.output, /Verify:/);
  assert.match(firstPreview.output, /--apply --approve [a-f0-9]{64}/);
  assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  for (const item of inspectTechnicianSkillEverywhere(skillOptions)) {
    assert.equal(item.status, "missing", "preview does not create a skill or its parent directories");
  }

  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      flags: { only: "technician-skill", apply: true, approve: "0".repeat(64) },
      skillOptions,
    }),
    /missing, stale, or different/i,
  );
  for (const item of inspectTechnicianSkillEverywhere(skillOptions)) assert.equal(item.status, "missing");

  const appliedSkill = await captured(() => cmdAssistantRepair(manifestPath, {
    flags: {
      only: "technician-skill",
      apply: true,
      approve: firstPreview.value.plan_id,
    },
    skillOptions,
  }));
  assert.equal(appliedSkill.value.results[0].status, "repaired");
  assert.match(appliedSkill.output, /No Brain records, sources, providers, access, zones, passkeys, devices, cloud resources, or CLI executable changed/);
  for (const item of inspectTechnicianSkillEverywhere(skillOptions)) assert.equal(item.status, "current");
  assert.deepEqual(readFileSync(manifestPath), manifestBefore, "the local repair never changes the manifest");

  const staleHome = join(sandbox, "stale-home");
  mkdirSync(staleHome, { recursive: true, mode: 0o700 });
  const stalePreview = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill"],
    { skillOptions: { home: staleHome } },
  );
  const stalePath = inspectTechnicianSkillEverywhere({ home: staleHome })[0].path;
  mkdirSync(dirname(stalePath), { recursive: true });
  writeFileSync(stalePath, "---\nname: owner-custom\n---\n", { mode: 0o600 });
  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      flags: {
        only: "technician-skill",
        apply: true,
        approve: stalePreview.plan_id,
      },
      skillOptions: { home: staleHome },
    }),
    /missing, stale, or different/i,
  );
  assert.equal(readFileSync(stalePath, "utf8"), "---\nname: owner-custom\n---\n");

  const skillSourceA = join(sandbox, "reviewed-skill-a.md");
  const skillSourceB = join(sandbox, "reviewed-skill-b.md");
  writeFileSync(skillSourceA, `${CLAUDE_TECHNICIAN_SKILL_MARKER}\n# Same release\nFirst reviewed behavior.\n`);
  writeFileSync(skillSourceB, `${CLAUDE_TECHNICIAN_SKILL_MARKER}\n# Same release\nSecond reviewed behavior.\n`);
  const skillContentHome = join(sandbox, "skill-content-approval");
  mkdirSync(skillContentHome, { recursive: true, mode: 0o700 });
  const skillContentPlanA = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill"],
    { skillOptions: { home: skillContentHome, sourcePath: skillSourceA } },
  );
  const skillContentPlanB = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill"],
    { skillOptions: { home: skillContentHome, sourcePath: skillSourceB } },
  );
  assert.notEqual(
    skillContentPlanA.plan_id,
    skillContentPlanB.plan_id,
    "same-version plans with different reviewed skill bytes require different approvals",
  );

  const skillMutationHome = join(sandbox, "skill-source-mutation");
  mkdirSync(skillMutationHome, { recursive: true, mode: 0o700 });
  const approvedSkillBytes = reviewedSkillContent(skillSourceA);
  const skillMutationPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill"],
    { skillOptions: { home: skillMutationHome, sourcePath: skillSourceA } },
  );
  await cmdAssistantRepair(manifestPath, {
    flags: {
      only: "technician-skill",
      apply: true,
      approve: skillMutationPlan.plan_id,
    },
    skillOptions: { home: skillMutationHome, sourcePath: skillSourceA },
    repairTechnicianSkills(options) {
      writeFileSync(skillSourceA, readFileSync(skillSourceB));
      return repairTechnicianSkillEverywhere(options);
    },
  });
  const installedAfterSourceMutation = inspectTechnicianSkillEverywhere({
    home: skillMutationHome,
    sourcePath: skillSourceB,
  })[0].path;
  assert.equal(
    readFileSync(installedAfterSourceMutation, "utf8"),
    approvedSkillBytes,
    "the repair writes the exact approved skill bytes even if its source changes after capture",
  );

  const alternateManifestRoot = join(sandbox, "same-bytes-different-location");
  mkdirSync(alternateManifestRoot, { recursive: true });
  const alternateManifestPath = join(alternateManifestRoot, "brain.manifest.json");
  writeFileSync(alternateManifestPath, readFileSync(manifestPath), { mode: 0o600 });
  const approvalBindingOptions = {
    mcpOptions: {
      environment: { HOME: sandbox, PATH: "", USER: process.env.USER || "fixture-user" },
      installed: { "claude-code-mcp": true },
      claudeConfigPath: join(sandbox, "approval-binding-claude.json"),
      verifyRuntime: () => true,
    },
  };
  const originalLocationPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    approvalBindingOptions,
  );
  const alternateLocationPlan = await buildLocalAssistantRepairPlan(
    alternateManifestPath,
    ["claude-code-mcp"],
    approvalBindingOptions,
  );
  assert.notEqual(
    originalLocationPlan.plan_id,
    alternateLocationPlan.plan_id,
    "identical manifest bytes at different absolute locators require different approvals",
  );
  const changedNodePlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    { mcpOptions: { ...approvalBindingOptions.mcpOptions, nodePath: join(sandbox, "alternate-node") } },
  );
  const changedServerPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    { mcpOptions: { ...approvalBindingOptions.mcpOptions, serverPath: join(sandbox, "alternate-server.mjs") } },
  );
  const changedDestinationPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    {
      mcpOptions: {
        ...approvalBindingOptions.mcpOptions,
        claudeConfigPath: join(sandbox, "alternate-destination.json"),
      },
    },
  );
  assert.notEqual(originalLocationPlan.plan_id, changedNodePlan.plan_id,
    "the approved plan binds the exact Node executable locator");
  assert.notEqual(originalLocationPlan.plan_id, changedServerPlan.plan_id,
    "the approved plan binds the exact MCP runtime locator");
  assert.notEqual(originalLocationPlan.plan_id, changedDestinationPlan.plan_id,
    "the approved plan binds the exact config destination");

  const rollbackHome = join(sandbox, "rollback-home");
  mkdirSync(rollbackHome, { recursive: true, mode: 0o700 });
  let skillInstallCalls = 0;
  assert.throws(
    () => repairTechnicianSkillEverywhere({
      home: rollbackHome,
      agentRoots: [".claude", ".codex"],
      installSkill(options) {
        skillInstallCalls++;
        if (skillInstallCalls === 2) throw new Error("synthetic second destination failure");
        return installClaudeTechnicianSkill(options);
      },
    }),
    /Every completed skill write was rolled back/i,
  );
  assert.equal(skillInstallCalls, 2);
  for (const item of inspectTechnicianSkillEverywhere({
    home: rollbackHome,
    agentRoots: [".claude", ".codex"],
  })) {
    assert.equal(item.status, "missing", "a failed multi-destination skill scope restores absence");
  }
  assert.deepEqual(
    pathInventory(rollbackHome),
    [],
    "a failed skill bundle removes every explicitly created private directory",
  );

  const mcpHome = join(sandbox, "mcp-home");
  mkdirSync(mcpHome, { recursive: true });
  const claudeConfigPath = join(mcpHome, ".claude.json");
  const codexConfigPath = join(mcpHome, ".codex", "config.toml");
  mkdirSync(dirname(codexConfigPath), { recursive: true });
  const codexSentinel = "model = \"owner-choice\"\n";
  writeFileSync(codexConfigPath, codexSentinel, { mode: 0o600 });
  const existingClaudeBackups = join(mcpHome, ".claude", "backups");
  mkdirSync(existingClaudeBackups, { recursive: true });
  const existingClaudeBackup = join(existingClaudeBackups, ".claude.json.backup.owner-sentinel");
  writeFileSync(existingClaudeBackup, "owner backup sentinel\n", { mode: 0o600 });
  const mcpTreeBefore = pathInventory(mcpHome);
  const calls = [];
  let durableReads = 0;
  const runner = (command, args, runOptions) => {
    calls.push({ command, args: [...args], environment: { ...runOptions.env } });
    assert.equal(command, "claude", "the unselected Codex CLI is never opened");
    if (args[0] === "--version") return { ok: true, out: "fixture" };
    if (args[0] === "mcp" && args[1] === "add") {
      const env = {};
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "-e") {
          const [key, ...rest] = args[++index].split("=");
          env[key] = rest.join("=");
        }
      }
      const separator = args.indexOf("--");
      const name = args[4];
      writeFileSync(claudeConfigPath, JSON.stringify({
        mcpServers: {
          [name]: {
            type: "stdio",
            command: args[separator + 1],
            args: args.slice(separator + 2),
            env,
          },
        },
      }, null, 2) + "\n", { mode: 0o600 });
      return { ok: true, out: "" };
    }
    throw new Error(`unexpected fixture command ${command} ${args.join(" ")}`);
  };
  const mcpOptions = {
    environment: {
      HOME: mcpHome,
      PATH: "/fixture/bin",
      USER: process.env.USER || "fixture-user",
      ADMIN_KEY: "must-not-reach-child",
      CLOUDFLARE_API_TOKEN: "must-not-reach-child-either",
    },
    installed: { "claude-code-mcp": true, "codex-mcp": true },
    claudeConfigPath,
    codexConfigPath,
    runCommand: runner,
    verifyRuntime: () => true,
    verifyMcpRuntime: () => true,
    adminKeyPersistencePlan: () => ({ fixture: true }),
    readAdminKeyDurably: () => { durableReads++; return "present-without-returning-it"; },
  };
  const mcpPreview = await captured(() => cmdAssistantRepair(manifestPath, {
    flags: { only: "claude-code-mcp" },
    mcpOptions,
  }));
  assert.equal(mcpPreview.value.items[0].status, "repairable");
  assert.equal(
    mcpPreview.value.items[0].protocol_discovery_verified,
    true,
    "the preview exposes protocol proof only after the packaged initialize and tools/list probe passes",
  );
  assert.equal(mcpPreview.value.write_set.length, 1);
  assert.equal(mcpPreview.value.write_set[0].path, claudeConfigPath);
  assert.equal(existsSync(claudeConfigPath), false, "MCP preview does not create a config");
  assert.equal(readFileSync(codexConfigPath, "utf8"), codexSentinel);
  assert.equal(calls.length, 0, "injected read-only assistant presence avoids every CLI call during preview");
  assert.equal(durableReads, 0, "preview never opens the durable admin-key store");

  const configuredCodexHome = join(sandbox, "configured-codex-preview");
  const configuredCodexRoot = join(configuredCodexHome, ".codex");
  const configuredCodexPath = join(configuredCodexRoot, "config.toml");
  mkdirSync(configuredCodexRoot, { recursive: true });
  writeFileSync(configuredCodexPath, "model = \"owner-preview-choice\"\n", { mode: 0o600 });
  const configuredCodexBefore = pathInventory(configuredCodexHome);
  const configuredCodexOptions = {
    mcpOptions: {
      environment: {
        HOME: configuredCodexHome,
        CODEX_HOME: configuredCodexRoot,
        PATH: "/a/path/that/is-never-executed",
        USER: process.env.USER || "fixture-user",
      },
      codexConfigPath: configuredCodexPath,
      runCommand: () => { throw new Error("a read-only preview must not execute Codex"); },
      verifyRuntime: () => true,
      adminKeyPersistencePlan: () => ({ fixture: true }),
      readAdminKeyDurably: () => "present",
    },
  };
  const codexPreview = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["codex-mcp"],
    configuredCodexOptions,
  );
  assert.equal(codexPreview.items[0].status, "repairable");
  assert.deepEqual(
    pathInventory(configuredCodexHome),
    configuredCodexBefore,
    "Codex preview preserves every configured-home path, mode, and byte",
  );
  await cmdAssistantRepair(manifestPath, {
    ...configuredCodexOptions,
    flags: { only: "codex-mcp", apply: true, approve: codexPreview.plan_id },
  });
  assert.match(
    readFileSync(configuredCodexPath, "utf8"),
    /^model = "owner-preview-choice"\n\[mcp_servers\.fixture-brain]/,
    "a one-newline owner config remains exact and receives only the needed TOML table delimiter",
  );

  const dottedCodexHome = join(sandbox, "dotted-codex-preserved");
  const dottedCodexRoot = join(dottedCodexHome, ".codex");
  const dottedCodexPath = join(dottedCodexRoot, "config.toml");
  mkdirSync(dottedCodexRoot, { recursive: true, mode: 0o700 });
  const dottedCodexBytes =
    "model = \"owner-choice\"\n" +
    "mcp_servers.fixture-brain = { command = \"/owner/custom\", args = [] }\n";
  writeFileSync(dottedCodexPath, dottedCodexBytes, { mode: 0o600 });
  const dottedCodexPlan = await buildLocalAssistantRepairPlan(manifestPath, ["codex-mcp"], {
    mcpOptions: {
      environment: { HOME: dottedCodexHome, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
      installed: { "codex-mcp": true },
      codexConfigPath: dottedCodexPath,
      verifyRuntime: () => true,
      runCommand: () => { throw new Error("a preserved Codex entry must not execute a client"); },
    },
  });
  assert.equal(dottedCodexPlan.items[0].status, "preserved");
  assert.equal(dottedCodexPlan.write_set.length, 0);
  assert.equal(
    readFileSync(dottedCodexPath, "utf8"),
    dottedCodexBytes,
    "a dotted or inline same-name Codex entry is preserved instead of duplicated",
  );

  const freshCodexHome = join(sandbox, "path-installed-fresh-codex");
  const freshCodexBin = join(sandbox, "path-installed-bin");
  mkdirSync(freshCodexHome, { recursive: true });
  mkdirSync(freshCodexBin, { recursive: true });
  const freshCodexExecutable = join(freshCodexBin, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(freshCodexExecutable, process.platform === "win32" ? "@exit /b 99\r\n" : "#!/bin/sh\nexit 99\n");
  if (process.platform !== "win32") chmodSync(freshCodexExecutable, 0o755);
  const freshCodexOptions = {
    mcpOptions: {
      environment: {
        HOME: freshCodexHome,
        PATH: freshCodexBin,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        USER: process.env.USER || "fixture-user",
      },
      runCommand: () => { throw new Error("presence detection must not execute Codex"); },
      verifyRuntime: () => true,
      adminKeyPersistencePlan: () => ({ fixture: true }),
      readAdminKeyDurably: () => "present",
    },
  };
  const freshCodexPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["codex-mcp"],
    freshCodexOptions,
  );
  assert.deepEqual(
    freshCodexPlan.write_set.map((entry) => entry.path),
    [join(freshCodexHome, ".codex"), join(freshCodexHome, ".codex", "config.toml")],
    "a PATH-installed fresh Codex preview includes its private parent directory",
  );
  await cmdAssistantRepair(manifestPath, {
    ...freshCodexOptions,
    flags: { only: "codex-mcp", apply: true, approve: freshCodexPlan.plan_id },
  });
  assert.deepEqual(
    pathInventory(freshCodexHome).map((entry) => entry.path),
    [".codex/", ".codex/config.toml"],
    "fresh Codex apply creates only the two approved paths and no tmp/arg0 residue",
  );

  const mcpApplied = await captured(() => cmdAssistantRepair(manifestPath, {
    flags: {
      only: "claude-code-mcp",
      apply: true,
      approve: mcpPreview.value.plan_id,
    },
    mcpOptions,
  }));
  assert.equal(mcpApplied.value.results[0].status, "repaired");
  assert.equal(durableReads, 1, "the durable key is checked only inside the approved apply");
  assert.equal(readFileSync(codexConfigPath, "utf8"), codexSentinel, "unselected Codex config is byte-identical");
  const claudeConfig = readFileSync(claudeConfigPath, "utf8");
  assert.match(claudeConfig, /BRAIN_AGENT_PROFILE/);
  assert.doesNotMatch(claudeConfig, /ADMIN_KEY|BRAIN_KEY|must-not-reach-child/);
  assert.equal(JSON.stringify(calls).includes("must-not-reach-child"), false, "no ambient secret enters argv or child environment");
  assert.equal(calls.length, 0, "approved local repair never executes Claude");
  assert.deepEqual(
    pathInventory(mcpHome).filter((entry) => entry.path !== ".claude.json"),
    mcpTreeBefore,
    "successful fresh Claude repair changes only its previewed config and preserves backup sentinels",
  );

  const losslessClaudeHome = join(sandbox, "lossless-claude-config");
  mkdirSync(losslessClaudeHome, { recursive: true, mode: 0o700 });
  const losslessClaudePath = join(losslessClaudeHome, ".claude.json");
  const losslessClaudeBytes =
    "{\n  \"ownerCounter\":9007199254740993,\n  \"ownerText\" : \"keep exact spacing\"\n}\n";
  writeFileSync(losslessClaudePath, losslessClaudeBytes, { mode: 0o600 });
  const losslessClaudeOptions = {
    mcpOptions: {
      environment: { HOME: losslessClaudeHome, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
      installed: { "claude-code-mcp": true },
      claudeConfigPath: losslessClaudePath,
      verifyRuntime: () => true,
      adminKeyPersistencePlan: () => ({ fixture: true }),
      readAdminKeyDurably: () => "present",
      runCommand: () => { throw new Error("the narrow repair must not execute Claude"); },
    },
  };
  const losslessClaudePlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    losslessClaudeOptions,
  );
  await cmdAssistantRepair(manifestPath, {
    ...losslessClaudeOptions,
    flags: { only: "claude-code-mcp", apply: true, approve: losslessClaudePlan.plan_id },
  });
  const losslessClaudeAfter = readFileSync(losslessClaudePath, "utf8");
  assert.equal(
    losslessClaudeAfter.endsWith(losslessClaudeBytes.slice(1)),
    true,
    "Claude repair preserves every unrelated raw byte, including integers beyond JavaScript's safe range",
  );
  assert.match(losslessClaudeAfter, /"ownerCounter":9007199254740993/);

  const customHome = join(sandbox, "custom-home");
  mkdirSync(customHome, { recursive: true });
  const customClaudePath = join(customHome, ".claude.json");
  const customBytes = JSON.stringify({
    mcpServers: {
      "fixture-brain": {
        enabled: false,
        type: "stdio",
        command: "/owner/custom-command",
        args: ["custom"],
        env: { OWNER_SETTING: "preserve" },
      },
    },
  }, null, 2) + "\n";
  writeFileSync(customClaudePath, customBytes, { mode: 0o600 });
  const preserved = await cmdAssistantRepair(manifestPath, {
    flags: { only: "claude-code-mcp" },
    mcpOptions: {
      environment: { HOME: customHome, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
      installed: { "claude-code-mcp": true },
      claudeConfigPath: customClaudePath,
      verifyRuntime: () => true,
      runCommand: () => { throw new Error("a preserved entry must not invoke a CLI"); },
    },
  });
  assert.equal(preserved.items[0].status, "preserved");
  assert.equal(preserved.write_set.length, 0);
  assert.equal(readFileSync(customClaudePath, "utf8"), customBytes);

  const snapshotMutationHome = join(sandbox, "snapshot-mutation-home");
  mkdirSync(snapshotMutationHome, { recursive: true, mode: 0o700 });
  const snapshotMutationPath = join(snapshotMutationHome, ".claude.json");
  const snapshotRuntime = writePriorInstallerRuntime(join(sandbox, "snapshot-prior-runtime"));
  const snapshotDesired = mcpRegistrationDescriptor(manifest, manifestPath, {
    baseUrl: "https://fixture.invalid",
  });
  const { BRAIN_AGENT_PROFILE: _snapshotProfile, ...snapshotPriorEnv } = snapshotDesired.env;
  const snapshotMutationBytes = `${JSON.stringify({
    mcpServers: {
      [snapshotDesired.name]: {
        type: "stdio",
        command: snapshotDesired.command,
        args: [snapshotRuntime],
        env: snapshotPriorEnv,
      },
    },
  }, null, 2)}\n`;
  let snapshotVerifyCalls = 0;
  let snapshotWriteCalls = 0;
  const snapshotMutationOptions = {
    mcpOptions: {
      environment: { HOME: snapshotMutationHome, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
      installed: { "claude-code-mcp": true },
      claudeConfigPath: snapshotMutationPath,
      verifyRuntime() {
        snapshotVerifyCalls++;
        if (snapshotVerifyCalls === 2) {
          writeFileSync(snapshotMutationPath, snapshotMutationBytes, { mode: 0o600 });
        }
        return true;
      },
      adminKeyPersistencePlan: () => ({ fixture: true }),
      readAdminKeyDurably: () => "present",
      writeLocalMcpRegistration({ prepared, desired, writeDefault }) {
        snapshotWriteCalls++;
        return writeDefault(prepared, desired);
      },
    },
  };
  const snapshotMutationPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    snapshotMutationOptions,
  );
  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      ...snapshotMutationOptions,
      flags: {
        only: "claude-code-mcp",
        apply: true,
        approve: snapshotMutationPlan.plan_id,
      },
    }),
    /changed after its approved preview/i,
  );
  assert.equal(snapshotWriteCalls, 0, "a changed MCP destination is rejected before the first repair write");
  assert.equal(
    readFileSync(snapshotMutationPath, "utf8"),
    snapshotMutationBytes,
    "the concurrent MCP value is preserved byte-for-byte",
  );

  const manifestDriftHome = join(sandbox, "manifest-drift-home");
  mkdirSync(manifestDriftHome, { recursive: true, mode: 0o700 });
  const manifestDriftConfig = join(manifestDriftHome, ".claude.json");
  const manifestDriftOptions = {
    mcpOptions: {
      environment: { HOME: manifestDriftHome, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
      installed: { "claude-code-mcp": true },
      claudeConfigPath: manifestDriftConfig,
      verifyRuntime: () => true,
      adminKeyPersistencePlan: () => ({ fixture: true }),
      readAdminKeyDurably: () => "present",
      writeLocalMcpRegistration({ prepared, desired, writeDefault }) {
        const result = writeDefault(prepared, desired);
        writeFileSync(
          manifestPath,
          `${JSON.stringify({ ...manifest, brain: { ...manifest.brain, domain: "changed.invalid" } }, null, 2)}\n`,
          { mode: 0o600 },
        );
        return result;
      },
    },
  };
  const manifestDriftPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp"],
    manifestDriftOptions,
  );
  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      ...manifestDriftOptions,
      flags: {
        only: "claude-code-mcp",
        apply: true,
        approve: manifestDriftPlan.plan_id,
      },
    }),
    /manifest changed before the approved repair could finish/i,
  );
  assert.equal(existsSync(manifestDriftConfig), false, "final manifest drift rolls back the completed config write");
  writeFileSync(manifestPath, manifestBefore, { mode: 0o600 });

  const failedHome = join(sandbox, "failed-add-home");
  mkdirSync(failedHome, { recursive: true });
  const failedConfig = join(failedHome, ".claude.json");
  const failedRunner = (command, args) => {
    if (command !== "claude") throw new Error("unselected client invoked");
    if (args[0] === "--version") return { ok: true, out: "fixture" };
    if (args[0] === "mcp" && args[1] === "remove") {
      writeFileSync(failedConfig, "{}\n", { mode: 0o600 });
      return { ok: true, out: "" };
    }
    if (args[0] === "mcp" && (args[1] === "add" || args[1] === "add-json")) {
      writeFileSync(failedConfig, JSON.stringify({
        mcpServers: {
          "fixture-brain": {
            type: "stdio",
            command: "/wrong/runtime",
            args: [],
            env: {},
          },
        },
      }) + "\n", { mode: 0o600 });
      return { ok: true, out: "" };
    }
    throw new Error("unexpected failed-add fixture command");
  };
  const failedResult = await wireAgents(manifest, manifestPath, {
    targets: ["claude-code-mcp"],
    environment: { HOME: failedHome, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
    claudeConfigPath: failedConfig,
    baseUrl: "https://fixture.invalid",
    runCommand: failedRunner,
    verifyMcpRuntime: () => true,
    adminKeyPersistencePlan: () => ({ fixture: true }),
    readAdminKeyDurably: () => "present",
  });
  assert.deepEqual(failedResult.failures, ["Claude Code"]);
  assert.equal(existsSync(failedConfig), false, "a failed add restores a previously absent config");

  const transactionalOptions = (home, failScope) => {
    mkdirSync(home, { recursive: true });
    const claudePath = join(home, ".claude.json");
    const codexPath = join(home, ".codex", "config.toml");
    return {
      skillOptions: { home },
      mcpOptions: {
        environment: { HOME: home, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
        installed: { "claude-code-mcp": true, "codex-mcp": true },
        claudeConfigPath: claudePath,
        codexConfigPath: codexPath,
        runCommand: () => { throw new Error("assistant repair must not execute a vendor CLI"); },
        verifyRuntime: () => true,
        verifyMcpRuntime: () => true,
        adminKeyPersistencePlan: () => ({ fixture: true }),
        readAdminKeyDurably: () => "present",
        writeLocalMcpRegistration({ scope, prepared, desired, writeDefault }) {
          if (scope === failScope) throw new Error(`synthetic ${scope} write failure`);
          return writeDefault(prepared, desired);
        },
      },
      claudePath,
      codexPath,
    };
  };

  const secondFailureHome = join(sandbox, "bundle-second-failure");
  const secondFailure = transactionalOptions(secondFailureHome, "claude-code-mcp");
  const secondPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill", "claude-code-mcp"],
    secondFailure,
  );
  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      ...secondFailure,
      flags: {
        only: "technician-skill,claude-code-mcp",
        apply: true,
        approve: secondPlan.plan_id,
      },
    }),
    /Every write destination in this approved bundle was restored/i,
  );
  for (const item of inspectTechnicianSkillEverywhere({ home: secondFailureHome })) {
    assert.equal(item.status, "missing", "scope 2 failure restores scope 1 skill writes");
  }
  assert.equal(existsSync(secondFailure.claudePath), false, "scope 2 restores its failed config absence");

  const thirdFailureHome = join(sandbox, "bundle-third-failure");
  const thirdFailure = transactionalOptions(thirdFailureHome, "codex-mcp");
  mkdirSync(dirname(thirdFailure.claudePath), { recursive: true });
  const priorRuntime = writePriorInstallerRuntime(join(sandbox, "prior-runtime-install"));
  const desiredForTransaction = mcpRegistrationDescriptor(manifest, manifestPath, {
    baseUrl: "https://fixture.invalid",
  });
  const { BRAIN_AGENT_PROFILE: _profile, ...priorLocatorEnv } = desiredForTransaction.env;
  const thirdClaudeBefore = `${JSON.stringify({
    ownerSetting: { keep: true },
    mcpServers: {
      [desiredForTransaction.name]: {
        type: "stdio",
        command: desiredForTransaction.command,
        args: [priorRuntime],
        env: priorLocatorEnv,
      },
    },
  }, null, 2)}\n`;
  writeFileSync(thirdFailure.claudePath, thirdClaudeBefore, { mode: 0o600 });
  const thirdPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill", "claude-code-mcp", "codex-mcp"],
    thirdFailure,
  );
  assert.equal(
    thirdPlan.items.find((item) => item.scope === "claude-code-mcp")?.status,
    "repairable",
    "the state-bound preview recognizes the exact same-Brain v0.4.0 runtime locator",
  );
  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      ...thirdFailure,
      flags: {
        only: "technician-skill,claude-code-mcp,codex-mcp",
        apply: true,
        approve: thirdPlan.plan_id,
      },
    }),
    /Every write destination in this approved bundle was restored/i,
  );
  for (const item of inspectTechnicianSkillEverywhere({ home: thirdFailureHome })) {
    assert.equal(item.status, "missing", "scope 3 failure restores scope 1 skill writes");
  }
  assert.equal(
    readFileSync(thirdFailure.claudePath, "utf8"),
    thirdClaudeBefore,
    "scope 3 restores the earlier successful Claude write to exact prior bytes",
  );
  assert.equal(existsSync(thirdFailure.codexPath), false, "scope 3 restores its failed Codex config absence");

  const freshProfileHome = join(sandbox, "fresh-profile-rollback");
  mkdirSync(join(freshProfileHome, ".codex"), { recursive: true });
  mkdirSync(join(freshProfileHome, ".claude", "backups"), { recursive: true });
  writeFileSync(
    join(freshProfileHome, ".claude", "backups", ".claude.json.backup.owner-sentinel"),
    "preserve this owner backup\n",
    { mode: 0o600 },
  );
  const freshProfile = transactionalOptions(freshProfileHome, "codex-mcp");
  const freshProfileBefore = pathInventory(freshProfileHome);
  const freshProfilePlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["claude-code-mcp", "codex-mcp"],
    freshProfile,
  );
  await assert.rejects(
    cmdAssistantRepair(manifestPath, {
      ...freshProfile,
      flags: {
        only: "claude-code-mcp,codex-mcp",
        apply: true,
        approve: freshProfilePlan.plan_id,
      },
    }),
    /Every write destination in this approved bundle was restored/i,
  );
  assert.deepEqual(
    pathInventory(freshProfileHome),
    freshProfileBefore,
    "a downstream failure leaves no Claude sidecar, backup, Codex cache, lock, or config residue",
  );

  await assert.rejects(
    wireAgents(manifest, manifestPath, { targets: ["codex-mcp", "codex-mcp"] }),
    /unique nonempty selection/i,
  );

  console.log("assistant repair: preview, exact scopes, approval binding, preservation, rollback, readback, and secret boundaries passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
