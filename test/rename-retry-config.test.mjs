import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Expose existing local writers only in this process, without expanding the CLI API.
const brainUrl = new URL("../brain.mjs", import.meta.url).href;
const skillUrl = new URL("../operations/claude-skill.mjs", import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const names = url === brainUrl
    ? "saveCalendarState, captureAgentConfigFile, configOutsideTarget, atomicReplaceAgentConfig, restoreAgentConfigFile"
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
      return { path, run: () => skill.restoreSkillSnapshot(saved) };
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

for (const site of sites) {
  for (const mutation of ["control", "destination", "staging"]) {
    test(`${site.name} retry identity: ${mutation}`, { skip: process.platform !== "win32" }, t => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-rename-config-")));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const f = site.prepare(root);
      let calls = 0, destination, priorBytes, changedPath, replacementBytes, result, error;
      fs.renameSync = (from, to) => {
        if (site.notWritten ? !from.endsWith(".tmp") : to !== f.path) return nativeRename(from, to);
        calls++;
        destination = to;
        if (calls === 1) {
          priorBytes = fs.existsSync(to) ? fs.readFileSync(to) : null;
          if (mutation !== "control") {
            changedPath = mutation === "staging" ? from : to;
            // Keep the old inode alive, so NTFS cannot recycle it for the replacement.
            replacementBytes = fs.existsSync(changedPath) ? fs.readFileSync(changedPath) : Buffer.from("replacement\n");
            if (fs.existsSync(changedPath)) nativeRename(changedPath, `${changedPath}.displaced`);
            fs.writeFileSync(changedPath, replacementBytes);
          }
          throw Object.assign(new Error("synthetic rename refusal"), { code: "EPERM" });
        }
        return nativeRename(from, to);
      };
      syncBuiltinESMExports();
      try { result = f.run(); } catch (cause) { error = cause; }
      finally { fs.renameSync = nativeRename; syncBuiltinESMExports(); }
      if (mutation === "control") {
        assert.equal(calls, 2, "unchanged identities allow the next rename");
        assert.ok(!error, "unchanged identities allow the writer to finish");
        if (site.returnsFalse) assert.equal(result, true);
        if (site.notWritten) assert.equal(result.status, "written");
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
        } else if (mutation === "staging" && !site.notWritten) {
          assert.ok(fs.readFileSync(destination).equals(priorBytes), "staging replacement must not reach destination");
        }
      }
    });
  }
}
