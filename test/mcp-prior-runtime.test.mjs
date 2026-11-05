import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mcpRegistrationDescriptor, mcpRegistrationIsExact,
  mcpRegistrationIsInstallerOwned, wireAgents } from "../brain.mjs";

const runningVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
const historicalBytes = readFileSync(new URL("./fixtures/published-v0.4.0-brain-mcp.mjs", import.meta.url));
const structuralBytes = 'throw new Error("prior runtime must never execute");\n';
const manifest = { client: { slug: "fixture-brain" }, brain: { domain: "fixture.invalid" },
  operations: { admin_key_secret: null } };

function entryFromArgs(args, flag) {
  const separator = args.indexOf("--");
  assert.ok(separator > 0, "the actual CLI call carries a runtime");
  const env = {};
  for (let index = 0; index < separator; index++) {
    if (args[index] !== flag) continue;
    const assignment = args[++index];
    const equals = assignment.indexOf("=");
    env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  return { type: "stdio", command: args[separator + 1], args: args.slice(separator + 2), env };
}

async function exercise({ prefix = ".financial-brain-owner-session-0420/install", version = "0.4.20",
  packageName = "brain-installer", target = "claude", historical = false, layout = "lib",
  change = () => {}, pathChange = () => {}, failAdd = false, mismatch = false } = {}, check) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mcp-prior-")));
  const manifestPath = join(home, "brain.manifest.json");
  const keyPath = join(home, ".brain-admin-key");
  const packageRoot = join(home, prefix, ...(layout ? [layout] : []), "node_modules", "brain-installer");
  const runtime = join(packageRoot, "components", "brain-mcp.mjs");
  mkdirSync(dirname(runtime), { recursive: true, mode: 0o700 });
  writeFileSync(runtime, historical ? historicalBytes : structuralBytes, { mode: 0o600 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version }), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const desired = mcpRegistrationDescriptor(manifest, manifestPath, { baseUrl: "https://fixture.invalid" });
  const entry = { type: "stdio", command: desired.command, args: [runtime], env: { ...desired.env } };
  change(entry, home);
  pathChange({ runtime, packageRoot, home });
  const configPath = target === "claude" ? join(home, ".claude.json") : join(home, ".codex", "config.toml");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  let codexEntry = null;
  function writeEntry(value) {
    if (target === "claude") {
      writeFileSync(configPath, JSON.stringify({ owner_setting: "keep", mcpServers: value
        ? { [desired.name]: value } : {} }), { mode: 0o600 });
    } else {
      codexEntry = value;
      const lines = ['owner_setting = "keep"'];
      if (value) {
        lines.push(`[mcp_servers.${desired.name}]`, `command = ${JSON.stringify(value.command)}`,
          `args = ${JSON.stringify(value.args)}`);
        if (value.cwd) lines.push(`cwd = ${JSON.stringify(value.cwd)}`);
        if (value.env_vars) lines.push(`env_vars = ${JSON.stringify(value.env_vars)}`);
        lines.push(`[mcp_servers.${desired.name}.env]`);
        for (const [key, item] of Object.entries(value.env)) lines.push(`${key} = ${JSON.stringify(item)}`);
      }
      writeFileSync(configPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    }
  }
  writeEntry(entry);
  const before = readFileSync(configPath);
  const calls = [];
  const verified = [];
  const output = [];
  let keyReads = 0;
  let backups = 0;
  const log = console.log;
  console.log = (...parts) => output.push(parts.join(" "));
  try {
    assert.ok(existsSync(runtime), "the existing runtime decision input exists");
    assert.equal(statSync(runtime).isFile(), true);
    const owned = mcpRegistrationIsInstallerOwned(entry, desired);
    const result = await wireAgents(manifest, manifestPath, {
      environment: { HOME: home, PATH: "/usr/bin:/bin", BRAIN_NO_WRANGLER_LOGIN: "1" },
      targets: [target === "claude" ? "claude-code-mcp" : "codex-mcp"],
      baseUrl: "https://fixture.invalid", claudeConfigPath: configPath, codexConfigPath: configPath,
      adminKeyPersistencePlan: () => ({ path: keyPath }),
      readAdminKeyDurably: (plan) => { keyReads++; return readFileSync(plan.path, "utf8"); },
      verifyMcpRuntime(descriptor) { verified.push(descriptor); return true; },
      runCommand(command, args, options) {
        calls.push({ command, args: [...args] });
        assert.equal(options.inheritEnv, false);
        assert.equal(command, target, "no scheduler or credential helper can run");
        if (args[0] === "--version") return { ok: true };
        assert.equal(args[0], "mcp");
        if (args[1] === "remove") {
          copyFileSync(configPath, join(home, "fixture-config-backup"));
          backups++;
          writeEntry(null);
          return { ok: true };
        }
        if (["add", "add-json"].includes(args[1])) {
          if (failAdd) return { ok: false };
          const value = args[1] === "add-json" ? JSON.parse(args[5])
            : entryFromArgs(args, target === "claude" ? "-e" : "--env");
          if (mismatch) value.env.BRAIN_URL = "https://other.invalid";
          writeEntry(value);
          return { ok: true };
        }
        assert.equal(target, "codex");
        assert.equal(args[1], "get");
        assert.ok(codexEntry, "Codex readback reaches the written registration");
        return { ok: true, stdout: `${desired.name}\ncommand: ${codexEntry.command}\nargs: ${codexEntry.args.join(" ")}\nenv: ${Object.keys(codexEntry.env).map((key) => `${key}=*****`).join(", ")}\n` };
      },
    });
    assert.equal(keyReads, 1, "the real reconciler passed durable-key verification");
    assert.equal(verified.length, 1, "the real reconciler reached the ownership decision after its handshake");
    assert.deepEqual(verified[0].args, desired.args, "only the current runtime is verified");
    assert.notEqual(verified[0].args[0], runtime, "the prior executable is never probed");
    const after = readFileSync(configPath);
    const current = target === "claude" ? JSON.parse(after).mcpServers[desired.name] : codexEntry;
    await check({ owned, result, calls, output: output.join("\n"), before, after, desired, entry,
      exact: mcpRegistrationIsExact(current, desired), backups,
      backupExact: backups > 0 && readFileSync(join(home, "fixture-config-backup")).equals(before) });
  } finally {
    console.log = log;
    rmSync(home, { recursive: true, force: true });
  }
}

function accepted(run, target = "Claude Code") {
  if (!run.owned) assert.match(run.output, /another MCP server already holds this name/,
    "the expected migration reached the name-collision decision on the old source");
  assert.equal(run.owned, true, "a prior installer entry is migratable");
  assert.deepEqual(run.result.wired, [target], "the existing entry must be rewritten");
  assert.deepEqual(run.result.failures, []);
  assert.equal(run.exact, true, "exact readback proves the current descriptor replaced the old runtime");
  assert.ok(run.calls.some((call) => call.args[1] === "add"));
  if (target === "Claude Code") {
    assert.equal(run.backups, 1, "the existing CLI backup path was reached");
    assert.equal(run.backupExact, true, "the backup preserves the original bytes");
  }
}

function refused(run, target = "Claude Code") {
  assert.match(run.output, /another MCP server already holds this name/,
    "the real name-collision decision was reached");
  assert.deepEqual(run.result.failures, [target]);
  assert.deepEqual(run.result.wired, []);
  assert.equal(run.owned, false);
  assert.ok(run.after.equals(run.before), "the refused config stays byte-for-byte unchanged");
  assert.equal(run.calls.filter((call) => ["remove", "add", "add-json"].includes(call.args[1])).length, 0);
}

test("historical exact-hash runtime provides a green control", () => exercise({
  prefix: ".financial-brain", version: "0.4.5", historical: true,
}, accepted));

for (const [prefix, version] of [
  [".financial-brain-owner-session-0420/install", "0.4.20"],
  [".financial-brain-v0.4.22", "0.4.22"],
]) {
  test(`prior ${prefix} runtime migrates to the current descriptor`, () => exercise({ prefix, version }, accepted));
}

for (const prefix of [".financial-brain", "financialbrain", ".financial-brain-v0.4.22-rc.1+kit.2",
  ".financial-brain-owner-session-0420.parked-review/install",
  ".financial-brain-owner-session-0420-20261101/install"]) {
  test(`recognized prefix ${prefix} supports the direct node_modules layout`, () => exercise({ prefix, layout: "" }, accepted));
}

for (const version of ["0.4.6", "0.4.6+kit.1", "0.4.25", "0.4.26-rc.1"]) {
  test(`earlier semver ${version} is structurally migratable`, () => exercise({ version }, accepted));
}

const negatives = [
  ["legacy wrong hash", { prefix: ".financial-brain", version: "0.4.5" }],
  ["current version", { version: runningVersion }],
  ["current version with build metadata", { version: `${runningVersion}+fixture.1` }],
  ["future version", { version: "0.4.99" }],
  ["next minor version", { version: "0.5.0" }],
  ["before structural lower bound", { version: "0.4.6-rc.1" }],
  ["non-semver", { version: "0.4.latest" }],
  ["version trailing newline", { version: "0.4.20\n" }],
  ["non-string version", { version: ["0.4.5"], historical: true, prefix: ".financial-brain" }],
  ["numeric leading zero", { version: "0.4.020" }],
  ["prerelease leading zero", { version: "0.4.20-01" }],
  ["wrong package name", { packageName: "fixture-package" }],
  ["version prefix lookalike", { prefix: ".financial-brain-vX" }],
  ["prefix trailing newline", { prefix: ".financial-brain-v0.4.22\n" }],
  ["version prefix leading zero", { prefix: ".financial-brain-v0.4.022" }],
  ["session prefix lookalike", { prefix: ".financial-brain-owner-session-evil/install" }],
  ["session digit lookalike", { prefix: ".financial-brain-owner-session-04201/install" }],
  ["wrong install child", { prefix: ".financial-brain-owner-session-0420/notinstall" }],
  ["extra path segment", { prefix: ".financial-brain-v0.4.22/extra" }],
  ["different manifest", { change: (entry, home) => { entry.env.BRAIN_MANIFEST = join(home, "other.manifest.json"); } }],
  ["extra env key", { change: (entry) => { entry.env.EXTRA = "fixture"; } }],
  ["literal key field", { change: (entry) => { entry.env.BRAIN_KEY = randomBytes(16).toString("hex"); } }],
  ["admin key field", { change: (entry) => { entry.env.ADMIN_KEY = randomBytes(16).toString("hex"); } }],
  ["different profile", { change: (entry) => { entry.env.BRAIN_AGENT_PROFILE = "read-only"; } }],
  ["missing profile", { change: (entry) => { delete entry.env.BRAIN_AGENT_PROFILE; } }],
  ["custom cwd", { change: (entry, home) => { entry.cwd = home; } }],
  ["inherited env", { change: (entry) => { entry.env_vars = ["EXTRA"]; } }],
  ["unknown envVars field", { change: (entry) => { entry.envVars = ["EXTRA"]; } }],
  ["foreign command", { change: (entry) => { entry.command = "fixture-executable"; } }],
  ["hardlinked runtime", { pathChange: ({ runtime, home }) => { linkSync(runtime, join(home, "linked-runtime")); } }],
  ["hardlinked package", { pathChange: ({ packageRoot, home }) => { linkSync(join(packageRoot, "package.json"), join(home, "linked-package")); } }],
];
if (process.platform !== "win32") {
  negatives.push(["symlink between recognized prefixes", { prefix: ".financial-brain", version: "0.4.5",
    historical: true, pathChange: ({ home }) => {
      renameSync(join(home, ".financial-brain"), join(home, "financialbrain"));
      symlinkSync("financialbrain", join(home, ".financial-brain"));
    },
  }]);
  negatives.push(["intermediate symlink", { pathChange: ({ packageRoot }) => {
    const components = join(packageRoot, "components");
    renameSync(components, join(packageRoot, "real-components"));
    symlinkSync("real-components", components);
  } }]);
}
for (const [label, options] of negatives) {
  const windowsUnrepresentable = process.platform === "win32" && /[\r\n]/.test(options.prefix ?? "");
  test(`prior runtime refuses ${label} at the collision decision`, {
    skip: windowsUnrepresentable ? "Windows cannot create a folder name containing a line break, so this prior runtime cannot exist there" : false,
  }, () => exercise(options, refused));
}

test("Codex migrates the same structural prior runtime", () => exercise({ target: "codex" }, (run) => accepted(run, "Codex")));
test("Codex refuses a different locator at the same collision decision", () => exercise({ target: "codex",
  change: (entry, home) => { entry.env.BRAIN_MANIFEST = join(home, "other.manifest.json"); },
}, (run) => refused(run, "Codex")));

for (const target of ["claude", "codex"]) {
  test(`${target} restores the original prior-runtime bytes when replacement readback fails`, () => exercise({ target,
    mismatch: true,
  }, (run) => {
    assert.equal(run.owned, true, "the migration decision was reached");
    assert.ok(run.calls.some((call) => call.args[1] === "add"), "replacement was attempted");
    assert.deepEqual(run.result.failures, [target === "claude" ? "Claude Code" : "Codex"]);
    assert.ok(run.after.equals(run.before), "snapshot restoration retains exact original bytes");
    assert.match(run.output, /previous entry was restored/);
  }));
}
