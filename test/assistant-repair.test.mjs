import assert from "node:assert/strict";
import {
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
  buildLocalAssistantRepairPlan,
  cmdAssistantRepair,
  wireAgents,
} from "../brain.mjs";
import {
  inspectTechnicianSkillEverywhere,
  installClaudeTechnicianSkill,
  repairTechnicianSkillEverywhere,
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
  const skillOptions = { home: skillHome };
  const manifestBefore = readFileSync(manifestPath);
  const firstPreview = await captured(() => cmdAssistantRepair(manifestPath, {
    flags: { only: "technician-skill" },
    skillOptions,
  }));
  assert.equal(firstPreview.value.read_only, true);
  assert.equal(firstPreview.value.mode, "preview");
  assert.equal(firstPreview.value.write_set.length, 2);
  assert.equal(firstPreview.value.transaction.scope, "complete-selected-write-set");
  assert.match(firstPreview.value.plan_id, /^[a-f0-9]{64}$/);
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

  const rollbackHome = join(sandbox, "rollback-home");
  let skillInstallCalls = 0;
  assert.throws(
    () => repairTechnicianSkillEverywhere({
      home: rollbackHome,
      installSkill(options) {
        skillInstallCalls++;
        if (skillInstallCalls === 2) throw new Error("synthetic second destination failure");
        return installClaudeTechnicianSkill(options);
      },
    }),
    /Every completed skill write was rolled back/i,
  );
  assert.equal(skillInstallCalls, 2);
  for (const item of inspectTechnicianSkillEverywhere({ home: rollbackHome })) {
    assert.equal(item.status, "missing", "a failed multi-destination skill scope restores absence");
  }

  const mcpHome = join(sandbox, "mcp-home");
  mkdirSync(mcpHome, { recursive: true });
  const claudeConfigPath = join(mcpHome, ".claude.json");
  const codexConfigPath = join(mcpHome, ".codex", "config.toml");
  mkdirSync(dirname(codexConfigPath), { recursive: true });
  const codexSentinel = "model = \"owner-choice\"\n";
  writeFileSync(codexConfigPath, codexSentinel, { mode: 0o600 });
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
  assert.equal(mcpPreview.value.write_set.length, 1);
  assert.equal(mcpPreview.value.write_set[0].path, claudeConfigPath);
  assert.equal(existsSync(claudeConfigPath), false, "MCP preview does not create a config");
  assert.equal(readFileSync(codexConfigPath, "utf8"), codexSentinel);
  assert.equal(calls.length, 0, "injected read-only assistant presence avoids every CLI call during preview");
  assert.equal(durableReads, 0, "preview never opens the durable admin-key store");

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
    const claudePath = join(home, ".claude.json");
    const codexPath = join(home, ".codex", "config.toml");
    const transactionRunner = (command, args) => {
      if (args[0] === "--version") return { ok: true, out: "fixture" };
      if (command === "claude" && args[0] === "mcp" && args[1] === "add") {
        const env = {};
        for (let index = 0; index < args.length; index++) {
          if (args[index] === "-e") {
            const [key, ...rest] = args[++index].split("=");
            env[key] = rest.join("=");
          }
        }
        const separator = args.indexOf("--");
        const name = args[4];
        mkdirSync(dirname(claudePath), { recursive: true });
        const existing = existsSync(claudePath)
          ? JSON.parse(readFileSync(claudePath, "utf8"))
          : {};
        writeFileSync(claudePath, JSON.stringify({
          ...existing,
          mcpServers: {
            ...(existing.mcpServers || {}),
            [name]: failScope === "claude-code-mcp"
              ? { type: "stdio", command: "/wrong/runtime", args: [], env: {} }
              : {
                  type: "stdio",
                  command: args[separator + 1],
                  args: args.slice(separator + 2),
                  env,
                },
          },
        }, null, 2) + "\n", { mode: 0o600 });
        return { ok: true, out: "" };
      }
      if (command === "codex" && args[0] === "mcp" && args[1] === "add") {
        mkdirSync(dirname(codexPath), { recursive: true });
        writeFileSync(
          codexPath,
          "[mcp_servers.fixture-brain]\ncommand = \"/wrong/runtime\"\nargs = []\n",
          { mode: 0o600 },
        );
        return { ok: true, out: "" };
      }
      throw new Error(`unexpected transaction fixture command ${command} ${args.join(" ")}`);
    };
    return {
      skillOptions: { home },
      mcpOptions: {
        environment: { HOME: home, PATH: "/fixture/bin", USER: process.env.USER || "fixture-user" },
        installed: { "claude-code-mcp": true, "codex-mcp": true },
        claudeConfigPath: claudePath,
        codexConfigPath: codexPath,
        runCommand: transactionRunner,
        verifyRuntime: () => true,
        verifyMcpRuntime: () => true,
        adminKeyPersistencePlan: () => ({ fixture: true }),
        readAdminKeyDurably: () => "present",
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
  const thirdClaudeBefore = "{\n  \"ownerSetting\": { \"keep\": true }\n}\n";
  writeFileSync(thirdFailure.claudePath, thirdClaudeBefore, { mode: 0o600 });
  const thirdPlan = await buildLocalAssistantRepairPlan(
    manifestPath,
    ["technician-skill", "claude-code-mcp", "codex-mcp"],
    thirdFailure,
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

  await assert.rejects(
    wireAgents(manifest, manifestPath, { targets: ["codex-mcp", "codex-mcp"] }),
    /unique nonempty selection/i,
  );

  console.log("assistant repair: preview, exact scopes, approval binding, preservation, rollback, readback, and secret boundaries passed");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
