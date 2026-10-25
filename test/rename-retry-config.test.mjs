import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pinStagingMtime, rewriteStagingInPlace, assertStagingSurvives } from "./fixtures/rename-retry-staging.mjs";

// Expose existing local writers only in this process, without expanding the CLI API.
const brainUrl = new URL("../brain.mjs", import.meta.url).href;
const skillUrl = new URL("../operations/claude-skill.mjs", import.meta.url).href;
const helperUrl = new URL("../operations/rename-retry.mjs", import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url === helperUrl) {
    const parts = String(loaded.source).split("platform = process.platform,");
    assert.equal(parts.length, 4, "baseline capture and both rename APIs retain their platform default");
    return { ...loaded, source: parts.join("platform = globalThis.__brainRenameTestPlatform ?? process.platform,") };
  }
  const names = url === brainUrl
    ? "saveCalendarState, captureAgentConfigFile, configOutsideTarget, atomicReplaceAgentConfig, restoreAgentConfigFile, claudeConfigWithExactRegistration"
    : url === skillUrl ? "restoreSkillSnapshot" : null;
  return names ? { ...loaded, source: `${loaded.source}\nexport { ${names} };\n` } : loaded;
} });
const brain = await import(brainUrl);
const skill = await import(skillUrl);
const { writeCodexWorkspaceGuide } = await import("../operations/claude-workspace.mjs");
const nativeRename = fs.renameSync;
const json = value => JSON.stringify(value);
const config = generation => Buffer.from(json({ mcpServers: { fixture: { generation } } }));

function snapshot(path) {
  const saved = { ...brain.captureAgentConfigFile(path), format: "claude-json", name: "fixture" };
  return { ...saved, outsideTarget: brain.configOutsideTarget(saved, saved.bytes) };
}

for (const existed of [false, true]) {
  for (const change of ["control", "refused", "unpublished", "published-replaced"]) {
    test(`assistant bundle rollback ownership: ${existed ? "prior file" : "prior absence"} ${change}`, async t => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-rename-bundle-")));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const manifestPath = join(root, "manifest.json"), target = join(root, "assistant.json");
      fs.writeFileSync(manifestPath, json({ client: { slug: "fixture-brain", display_name: "Fixture Owner" },
        brain: { version: "0.4.6", domain: "fixture.invalid", worker_name: "fixture-brain" },
        infrastructure: { cloudflare: { account_id: "fixture-account" } },
        operations: { admin_key_secret: "keychain://fixture-brain-admin/owner" } }));
      const prior = Buffer.from('{"ownerSetting":true}\n');
      if (existed) fs.writeFileSync(target, prior);
      let replacementIdentity, replacementBytes, calls = 0;
      const replace = bytes => {
        if (fs.existsSync(target)) nativeRename(target, `${target}.displaced`);
        fs.writeFileSync(target, bytes);
        replacementIdentity = fs.lstatSync(target, { bigint: true });
        replacementBytes = Buffer.from(bytes);
      };
      const options = { mcpOptions: {
        environment: { HOME: root, PATH: "/fixture/bin", USER: "fixture-owner" },
        installed: { "claude-code-mcp": true }, claudeConfigPath: target,
        verifyRuntime: () => true, adminKeyPersistencePlan: () => ({ fixture: true }),
        readAdminKeyDurably: () => "present",
        writeLocalMcpRegistration({ prepared, desired, writeDefault }) {
          if (change === "unpublished") {
            replace(brain.claudeConfigWithExactRegistration(prepared.snapshot, desired));
          } else {
            writeDefault(prepared, desired);
            if (change === "published-replaced") replace(fs.readFileSync(target));
          }
          throw new Error("synthetic later bundle failure");
        },
      } };
      const plan = await brain.buildLocalAssistantRepairPlan(manifestPath, ["claude-code-mcp"], options);
      assert.equal(plan.can_apply, true);
      globalThis.__brainRenameTestPlatform = "win32";
      fs.renameSync = (from, to) => {
        if (change === "refused" && to === target && ++calls === 1) {
          replace(fs.readFileSync(from));
          throw Object.assign(new Error("synthetic rename refusal"), { code: "EPERM" });
        }
        return nativeRename(from, to);
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(brain.cmdAssistantRepair(manifestPath, { ...options,
          flags: { only: "claude-code-mcp", apply: true, approve: plan.plan_id } }), /repair stopped/);
      } finally {
        fs.renameSync = nativeRename; syncBuiltinESMExports(); delete globalThis.__brainRenameTestPlatform;
      }
      if (change === "control") {
        if (existed) assert.deepEqual(fs.readFileSync(target), prior);
        else assert.equal(fs.existsSync(target), false);
      } else {
        assertStagingSurvives(target, replacementIdentity, replacementBytes);
        if (change === "refused") assert.equal(calls, 1, "a refused write gives rollback no publication authority");
      }
    });
  }
}

for (const change of ["control", "unpublished", "published-replaced"]) {
  test(`skill bundle rollback ownership: ${change}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-rename-skill-bundle-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const options = { home: root, agentRoots: [".claude", ".codex"] };
    const observations = skill.inspectTechnicianSkillEverywhere(options);
    const snapshots = skill.captureTechnicianSkillRepairSnapshot(observations);
    let replacementIdentity, replacementBytes, target, calls = 0;
    assert.throws(() => skill.repairTechnicianSkillEverywhere({ ...options, observations, snapshots,
      installSkill(input) {
        if (++calls === 2) throw new Error("synthetic later skill failure");
        target = skill.claudeTechnicianSkillPath(input);
        if (change === "unpublished") {
          fs.writeFileSync(target, input.desiredContent);
        } else {
          skill.installClaudeTechnicianSkill(input);
          if (change === "published-replaced") {
            const bytes = fs.readFileSync(target);
            nativeRename(target, `${target}.displaced`); fs.writeFileSync(target, bytes);
          }
        }
        replacementBytes = fs.readFileSync(target);
        replacementIdentity = fs.lstatSync(target, { bigint: true });
        if (change !== "control") throw new Error("synthetic concurrent skill failure");
        return { changed: true };
      },
    }), /synthetic/);
    if (change === "control") assert.equal(fs.existsSync(target), false);
    else assertStagingSurvives(target, replacementIdentity, replacementBytes);
  });
}

for (const replace of [false, true]) {
  test(`daily intent caller rollback ownership: ${replace ? "replacement survives" : "unchanged control"}`, async t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-rename-daily-intent-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const path = join(root, "manifest.json");
    const prior = { client: { slug: "fixture-brain" }, operations: { daily_refresh: { enabled: false } } };
    fs.writeFileSync(path, json(prior));
    let plans = 0, replacementIdentity, replacementBytes;
    await assert.rejects(brain.cmdScheduleAllConfigured(path, "install", {
      lifecycleLockHeld: true, quiet: true, platform: "win32",
      schedulerAdapter: { read: () => null },
      schedulerOptions: { nodePath: "C:\\Fixture\\node.exe", brainPath: "C:\\Fixture\\brain.mjs",
        runnerPath: "C:\\Fixture\\daily-refresh-run.mjs" },
      planDailyRefresh: async () => {
        if (++plans === 2) {
          if (replace) {
            replacementBytes = fs.readFileSync(path);
            nativeRename(path, `${path}.displaced`); fs.writeFileSync(path, replacementBytes);
            replacementIdentity = fs.lstatSync(path, { bigint: true });
          }
          throw new Error("synthetic later daily failure");
        }
        return { identity: { id: "v1-0123456789abcdef", principal: "fixture-owner" },
          manifest_path: path, manifest_path_hash: "sha256:path", manifest_content_hash: "sha256:content",
          source_plan_hash: "sha256:sources", cron: "0 9 * * *", timezone: "America/Phoenix",
          max_runtime_minutes: 45, enabled: true, ready: true, sources: [] };
      },
    }), /synthetic later daily failure/);
    assert.equal(plans, 2);
    if (replace) assertStagingSurvives(path, replacementIdentity, replacementBytes);
    else assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), prior);
  });
}

const sites = [
  {
    name: "manifest version", refusal: /the update manifest changed during local manifest version commit/,
    prepare(root) {
      const path = join(root, "manifest.json");
      fs.writeFileSync(path, json({ brain: { version: "0.0.1" } }));
      return { path, run: () => brain.commitManifestVersion(path, "0.0.2") };
    },
  },
  {
    name: "calendar checkpoint",
    prepare(root) {
      const path = join(root, "calendar.json");
      fs.writeFileSync(path, json({ generation: 1 }));
      return { path, run: () => brain.saveCalendarState(path, { generation: 2 }) };
    },
  },
  {
    name: "assistant configuration commit", refusal: /local assistant configuration changed before its approved write/,
    prepare(root) {
      const path = join(root, "assistant.json");
      fs.writeFileSync(path, config(1));
      const saved = snapshot(path);
      return { path, run: () => brain.atomicReplaceAgentConfig({ snapshot: saved,
        directorySnapshot: { exists: true, stat: fs.lstatSync(root) } }, config(2)) };
    },
  },
  {
    name: "assistant configuration rollback", returnsFalse: true,
    prepare(root) {
      const path = join(root, "assistant.json");
      fs.writeFileSync(path, config(1));
      const saved = snapshot(path);
      fs.writeFileSync(path, config(2));
      const current = brain.captureAgentConfigFile(path);
      return { path, run: () => brain.restoreAgentConfigFile(saved, current) };
    },
  },
  {
    name: "technician skill commit", refusal: /the skill destination changed after preview/,
    prepare(root) {
      const path = skill.claudeTechnicianSkillPath({ home: root });
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, `${skill.CLAUDE_TECHNICIAN_SKILL_MARKER}\nprior\n`);
      return { path, run: () => skill.installClaudeTechnicianSkill({ home: root,
        desiredContent: `${skill.CLAUDE_TECHNICIAN_SKILL_MARKER}\nnext\n` }) };
    },
  },
  {
    name: "technician skill rollback", returnsFalse: true,
    prepare(root) {
      const path = join(root, "SKILL.md");
      const desired = `${skill.CLAUDE_TECHNICIAN_SKILL_MARKER}\nnext\n`;
      fs.writeFileSync(path, desired);
      const saved = { path, exists: true, desired, bytes: Buffer.from("prior\n"),
        mode: fs.lstatSync(path).mode & 0o7777 };
      const publication = { identity: fs.lstatSync(path, { bigint: true }), bytes: Buffer.from(desired) };
      return { path, run: () => skill.restoreSkillSnapshot(saved, publication) };
    },
  },
  {
    name: "workspace staging", notWritten: true,
    prepare(root) {
      return { path: null, run: () => writeCodexWorkspaceGuide(join(root, "manifest.json"), {
        brainCliPath: join(root, "brain.mjs"), nodePath: process.execPath,
        platformName: "win32", ownership: { platform: "linux", userId: fs.lstatSync(root).uid },
      }) };
    },
  },
];

for (const name of ["calendar checkpoint", "technician skill commit"]) {
  for (const residue of [false, true]) test(`${name} staging name: ${residue ? "retained legacy residue" : "empty directory"}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-staging-name-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const f = sites.find(site => site.name === name).prepare(root);
    const now = Date.now;
    Date.now = () => 1700000000000;
    const stale = name === "calendar checkpoint" ? `${f.path}.tmp-${process.pid}-${Date.now()}` : `${f.path}.${process.pid}.tmp`;
    const bytes = Buffer.from("retained earlier attempt\n");
    if (residue) fs.writeFileSync(stale, bytes, { flag: "wx" });
    const identity = residue ? fs.lstatSync(stale, { bigint: true }) : null;
    try { f.run(); }
    finally { Date.now = now; }
    assert.ok(fs.existsSync(f.path));
    if (residue) assertStagingSurvives(stale, identity, bytes);
  });
}

for (const phase of ["baseline", "publication"]) for (const mode of ["control", "transient", "held"]) {
  test(`workspace staging observation: ${phase} ${mode}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-workspace-observation-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = { open: fs.openSync, read: fs.readFileSync, close: fs.closeSync };
    let staged, observations = 0, denials = 0;
    const options = { brainCliPath: join(root, "brain.mjs"), nodePath: process.execPath,
      platformName: "win32", ownership: { platform: "linux", userId: fs.lstatSync(root).uid } };
    const manifest = join(root, "manifest.json"), target = join(root, "AGENTS.md");
    const denied = () => mode !== "control" && (phase === "baseline" || observations > 1) &&
      (mode === "held" || denials === 0);
    fs.openSync = (path, flags, ...args) => {
      if (typeof path === "string" && path.endsWith(".tmp") && path.includes(".financial-brain-pending-")) {
        if (flags === "wx") staged = path;
        else {
          observations++;
          if (denied()) { denials++; throw Object.assign(new Error("synthetic read sharing lock"), { code: "EPERM" }); }
        }
      }
      return original.open(path, flags, ...args);
    };
    fs.readFileSync = (path, ...args) => {
      if (path === staged && phase === "publication" && mode !== "control") {
        denials++;
        throw Object.assign(new Error("synthetic read sharing lock"), { code: "EPERM" });
      }
      return original.read(path, ...args);
    };
    globalThis.__brainRenameTestPlatform = "win32";
    syncBuiltinESMExports();
    let result;
    try { result = writeCodexWorkspaceGuide(manifest, options); }
    finally {
      fs.openSync = original.open; fs.readFileSync = original.read;
      syncBuiltinESMExports(); delete globalThis.__brainRenameTestPlatform;
    }
    if (mode === "held") {
      assert.equal(result.status, "not_written");
      assert.equal(fs.existsSync(target), false);
      assert.equal(denials, 10, "the shared proof exhausts its bounded attempts");
      assert.equal(fs.existsSync(`${target}.lock`), false, "an unreadable unpublished attempt does not strand the writer lock");
      assert.ok(fs.existsSync(result.pendingPath), "the unreadable attempt stays retained for review");
      assert.equal(writeCodexWorkspaceGuide(manifest, options).status, "written", "a later attempt succeeds after the sharing lock is released");
    } else {
      assert.equal(result.status, "written");
      assert.equal(denials, mode === "transient" ? 1 : 0);
      assert.equal(fs.existsSync(`${target}.lock`), false);
    }
  });
}

for (const boundary of ["preparation", "parent"]) for (const phase of ["baseline", "retry"]) {
  for (const replaced of [false, true]) test(`workspace directory custody: ${boundary} ${phase} ${replaced ? "replacement refuses" : "unchanged control"}`, t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-workspace-custody-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const folder = join(root, "workspace"); fs.mkdirSync(folder);
    const manifest = join(folder, "manifest.json"), target = join(folder, "AGENTS.md");
    const original = { open: fs.openSync, close: fs.closeSync };
    let stagingPath, stagedDescriptor, changedPath, changedIdentity, observations = 0, reached = 0, renames = 0;
    const marker = "synthetic replacement directory\n";
    const replace = () => {
      reached++;
      if (!replaced) return;
      changedPath = boundary === "preparation" ? dirname(stagingPath) : folder;
      nativeRename(changedPath, `${changedPath}.displaced`);
      fs.mkdirSync(changedPath);
      fs.writeFileSync(join(changedPath, "owner-marker"), marker);
      changedIdentity = fs.lstatSync(changedPath, { bigint: true });
    };
    fs.openSync = (path, flags, ...args) => {
      if (typeof path === "string" && path.endsWith(".tmp") && path.includes(".financial-brain-pending-")) {
        if (flags === "wx") {
          stagingPath = path;
          stagedDescriptor = original.open(path, flags, ...args);
          return stagedDescriptor;
        }
        if (phase === "retry" && ++observations === 2) {
          replace();
          throw Object.assign(new Error("synthetic read sharing lock"), { code: "EPERM" });
        }
      }
      return original.open(path, flags, ...args);
    };
    fs.closeSync = descriptor => {
      const result = original.close(descriptor);
      if (descriptor === stagedDescriptor) {
        stagedDescriptor = undefined;
        if (phase === "baseline") replace();
      }
      return result;
    };
    fs.renameSync = (from, to) => {
      if (from === stagingPath) renames++;
      return nativeRename(from, to);
    };
    globalThis.__brainRenameTestPlatform = "win32"; syncBuiltinESMExports();
    let result;
    try {
      result = writeCodexWorkspaceGuide(manifest, { brainCliPath: join(root, "brain.mjs"), nodePath: process.execPath,
        platformName: "win32", ownership: { platform: "linux", userId: fs.lstatSync(root).uid } });
    } finally {
      fs.openSync = original.open; fs.closeSync = original.close; fs.renameSync = nativeRename;
      syncBuiltinESMExports(); delete globalThis.__brainRenameTestPlatform;
    }
    assert.equal(reached, 1, "the test reaches its selected custody boundary");
    if (replaced) {
      assert.equal(result.status, "not_written");
      assert.equal(renames, 0, "replaced directories cannot authorize any staged rename");
      assert.equal(fs.existsSync(target), false);
      const current = fs.lstatSync(changedPath, { bigint: true });
      assert.equal(current.dev, changedIdentity.dev); assert.equal(current.ino, changedIdentity.ino);
      assert.equal(fs.readFileSync(join(changedPath, "owner-marker"), "utf8"), marker);
    } else {
      assert.equal(result.status, "written");
      assert.equal(renames, 1);
      assert.equal(fs.existsSync(`${target}.lock`), false);
    }
  });
}

for (const site of sites) {
  const mutations = ["control", "destination", "staging", "staging-in-place",
    ...(!site.notWritten ? ["staging-eexist", "success-squat"] : [])];
  for (const mutation of mutations) {
    test(`${site.name} retry identity: ${mutation}`, t => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-rename-config-")));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const f = site.prepare(root);
      const restorePin = pinStagingMtime(root);
      const pinnedOpen = fs.openSync;
      globalThis.__brainRenameTestPlatform = "win32";
      let calls = 0, destination, priorBytes, changedPath, replacementBytes, replacementIdentity, result, error, fixtureError;
      if (mutation === "staging-eexist") {
        fs.openSync = (path, flags, ...args) => {
          const exclusive = typeof flags === "string" ? flags.includes("x")
            : (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0;
          if (!changedPath && exclusive) {
            try {
              changedPath = path;
              replacementBytes = Buffer.from("synthetic planted staging file\n");
              const planted = pinnedOpen(path, "wx", 0o600);
              try { fs.writeFileSync(planted, replacementBytes); }
              finally { fs.closeSync(planted); }
              replacementIdentity = fs.lstatSync(path, { bigint: true });
            } catch (cause) { fixtureError = cause; throw cause; }
          }
          return pinnedOpen(path, flags, ...args);
        };
      }
      fs.renameSync = (from, to) => {
        if (site.notWritten ? !from.endsWith(".tmp") : to !== f.path) return nativeRename(from, to);
        calls++;
        destination = to;
        if (mutation === "success-squat") {
          const renamed = nativeRename(from, to);
          try {
            changedPath = from;
            replacementBytes = Buffer.from("synthetic post-publication staging file\n");
            fs.writeFileSync(from, replacementBytes, { flag: "wx", mode: 0o600 });
            replacementIdentity = fs.lstatSync(from, { bigint: true });
          } catch (cause) { fixtureError = cause; throw cause; }
          return renamed;
        }
        if (calls === 1) {
          priorBytes = fs.existsSync(to) ? fs.readFileSync(to) : null;
          if (mutation === "staging-in-place") {
            try { rewriteStagingInPlace(from); }
            catch (cause) { fixtureError = cause; throw cause; }
          } else if (mutation !== "control") {
            changedPath = mutation === "staging" ? from : to;
            // Keep the old inode alive, so NTFS cannot recycle it for the replacement.
            replacementBytes = fs.existsSync(changedPath) ? fs.readFileSync(changedPath) : Buffer.from("replacement\n");
            if (fs.existsSync(changedPath)) nativeRename(changedPath, `${changedPath}.displaced`);
            fs.writeFileSync(changedPath, replacementBytes);
            replacementIdentity = fs.lstatSync(changedPath, { bigint: true });
          }
          throw Object.assign(new Error("synthetic rename refusal"), { code: "EPERM" });
        }
        return nativeRename(from, to);
      };
      syncBuiltinESMExports();
      try { result = f.run(); } catch (cause) { error = cause; }
      finally {
        fs.renameSync = nativeRename; restorePin(); syncBuiltinESMExports();
        delete globalThis.__brainRenameTestPlatform;
      }
      if (fixtureError) throw fixtureError;
      if (mutation === "staging-eexist") {
        assert.equal(calls, 0, "an exclusive-create collision must never reach rename");
        if (site.returnsFalse) assert.equal(result, false);
        else assert.equal(error?.code, "EEXIST", "the original exclusive-create error must survive cleanup");
        assertStagingSurvives(changedPath, replacementIdentity, replacementBytes);
      } else if (mutation === "control" || mutation === "success-squat") {
        assert.equal(calls, mutation === "control" ? 2 : 1, "unchanged identities allow publication");
        assert.ok(!error, "unchanged identities allow the writer to finish");
        if (site.returnsFalse) assert.equal(result, true);
        if (site.notWritten) assert.equal(result.status, "written");
        if (mutation === "success-squat") assertStagingSurvives(changedPath, replacementIdentity, replacementBytes);
      } else {
        assert.equal(calls, 1, "identity drift must stop before the next rename");
        if (site.returnsFalse) assert.equal(result, false, "rollback retains its existing refusal");
        else if (site.notWritten) assert.equal(result.status, "not_written");
        else {
          assert.ok(error, "changed identity must refuse publication");
          if (site.refusal && mutation === "destination") assert.match(error.message, site.refusal);
        }
        if (mutation === "destination" && !site.notWritten) {
          assert.ok(fs.readFileSync(destination).equals(replacementBytes), "replacement must not be overwritten");
        } else if (mutation.startsWith("staging") && !site.notWritten) {
          assert.ok(fs.readFileSync(destination).equals(priorBytes), "staging replacement must not reach destination");
        }
        if (mutation === "staging") assertStagingSurvives(changedPath, replacementIdentity, replacementBytes);
      }
    });
  }
}
