import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mcpRegistrationDescriptor, mcpRegistrationIsExact, wireAgents } from "../brain.mjs";
import { discoverClaudeMcpCommand } from "../operations/claude-mcp-discovery.mjs";

const manifest = {
  client: { slug: "fixture-brain", display_name: "Fixture Owner" },
  brain: { domain: "fixture.invalid" },
  operations: { admin_key_secret: null },
};

async function exercise({ candidate = "executable", pathWorks = false, nativeWorks = true, existing = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-discovery-"));
  const configPath = join(home, ".claude.json");
  const manifestPath = join(home, "brain.manifest.json");
  const native = join(home, ".local", "bin", "claude");
  const keyPath = join(home, ".brain-admin-key");
  mkdirSync(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  if (candidate === "directory") mkdirSync(native, { mode: 0o700 });
  else if (candidate !== "missing") {
    writeFileSync(native, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(native, candidate === "nonexecutable" ? 0o600 : 0o700);
  }
  const environment = { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" };
  const desired = mcpRegistrationDescriptor(manifest, manifestPath, { baseUrl: "https://fixture.invalid" });
  if (existing) {
    const env = { ...desired.env };
    delete env.BRAIN_AGENT_PROFILE;
    writeFileSync(configPath, JSON.stringify({ mcpServers: { [desired.name]: {
      type: desired.type, command: desired.command, args: desired.args, env,
    } } }), { mode: 0o600 });
  }
  const calls = [];
  let handshakes = 0;
  const priorLog = console.log;
  console.log = () => {};
  try {
    const result = await wireAgents(manifest, manifestPath, {
      platform: "darwin",
      environment,
      baseUrl: "https://fixture.invalid",
      targets: ["claude-code-mcp"],
      claudeConfigPath: configPath,
      adminKeyPersistencePlan: () => ({ path: keyPath }),
      readAdminKeyDurably: (plan) => readFileSync(plan.path, "utf8"),
      verifyMcpRuntime: () => { handshakes++; return true; },
      runCommand(command, args, options) {
        calls.push({ command, args: [...args] });
        assert.equal(options.inheritEnv, false);
        assert.deepEqual(options.env, environment);
        if (args[0] === "--version") {
          return { ok: command === "claude" ? pathWorks : command === native && nativeWorks };
        }
        assert.equal(command, pathWorks ? "claude" : native, "writes use the discovered executable");
        assert.equal(args[0], "mcp", "no scheduler or credential helper is invoked");
        if (args[1] === "remove") {
          writeFileSync(configPath, "{}", { mode: 0o600 });
          return { ok: true };
        }
        assert.equal(args[1], "add");
        assert.equal(args[4], desired.name);
        const separator = args.indexOf("--");
        assert.ok(separator > 4, "the actual CLI invocation carries its descriptor");
        const env = {};
        for (let index = 5; index < separator; index++) {
          if (args[index] !== "-e") continue;
          const assignment = args[++index];
          const equals = assignment.indexOf("=");
          env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
        }
        writeFileSync(configPath, JSON.stringify({ mcpServers: { [desired.name]: {
          type: "stdio", command: args[separator + 1], args: args.slice(separator + 2), env,
        } } }), { mode: 0o600 });
        return { ok: true };
      },
    });
    return {
      result, calls, handshakes,
      candidateExists: existsSync(native),
      candidateStat: existsSync(native) ? statSync(native) : null,
      exact: existsSync(configPath) && mcpRegistrationIsExact(
        JSON.parse(readFileSync(configPath, "utf8")).mcpServers[desired.name], desired,
      ),
      native,
    };
  } finally {
    console.log = priorLog;
    rmSync(home, { recursive: true, force: true });
  }
}

const posixFixture = { skip: process.platform === "win32" };

test("MCP wiring finds the native executable when PATH omits its directory", posixFixture, async () => {
  const run = await exercise();
  assert.equal(run.calls[0].command, "claude", "PATH discovery was reached");
  assert.equal(run.candidateStat.isFile(), true, "the native fixture is a regular file");
  assert.deepEqual(run.result.wired, ["Claude Code"], "the native install must be connected");
  assert.equal(run.handshakes, 1);
  assert.equal(run.exact, true, "the desired runtime passed exact config readback");
  assert.equal(run.calls.filter((call) => call.command === run.native).length, 2);
});

test("an existing registration also uses the native executable for removal and replacement", posixFixture, async () => {
  const run = await exercise({ existing: true });
  assert.equal(run.calls[0].command, "claude", "the PATH decision was reached");
  assert.deepEqual(run.result.wired, ["Claude Code"]);
  assert.equal(run.exact, true);
  assert.deepEqual(run.calls.filter((call) => call.args[0] === "mcp").map((call) => call.args[1]),
    ["remove", "add"]);
  assert.equal(run.calls.slice(1).every((call) => call.command === run.native), true);
});

test("PATH discovery keeps precedence over the native fallback", async () => {
  const run = await exercise({ pathWorks: true });
  assert.equal(run.calls[0].command, "claude");
  assert.equal(run.candidateExists, true, "both discovery choices exist");
  assert.deepEqual(run.result.wired, ["Claude Code"]);
  assert.equal(run.exact, true);
  assert.equal(run.calls.every((call) => call.command === "claude"), true);
});

for (const candidate of ["missing", "directory", "nonexecutable"]) {
  test(`native discovery refuses a ${candidate} candidate`, posixFixture, async () => {
    const run = await exercise({ candidate });
    assert.deepEqual(run.calls, [{ command: "claude", args: ["--version"] }],
      "the PATH decision was reached before refusing the fallback");
    assert.deepEqual(run.result.skipped, ["Claude Code"]);
    assert.equal(run.handshakes, 0);
    assert.equal(run.exact, false);
  });
}

test("a native executable must also pass its version probe", posixFixture, async () => {
  const run = await exercise({ nativeWorks: false });
  assert.equal(run.calls[0].command, "claude", "the PATH decision was reached");
  assert.equal(run.candidateStat.isFile(), true, "the native candidate exists");
  assert.equal(run.calls.filter((call) => call.command === run.native).length, 1,
    "the native version decision was reached");
  assert.deepEqual(run.result.skipped, ["Claude Code"]);
  assert.equal(run.handshakes, 0);
  assert.equal(run.exact, false);
});

function discoveryProbe({ uid = 1000, mode = 0o100700, file = true, home = "/fixture/home",
  platform = "darwin", pathWorks = false, nativeWorks = true, missing = false } = {}) {
  const probes = [];
  const stats = [];
  const command = discoverClaudeMcpCommand({
    environment: { HOME: home }, platform,
    getuid: () => 1000,
    stat(path) {
      stats.push(path);
      if (missing) throw new Error("fixture absent");
      return { uid, mode, isFile: () => file };
    },
    probe(path) {
      probes.push(path);
      return { ok: path === "claude" ? pathWorks : nativeWorks };
    },
  });
  return { command, probes, stats };
}

test("native discovery checks exactly one location and accepts its owned executable", () => {
  const run = discoveryProbe();
  const native = join("/fixture/home", ".local", "bin", "claude");
  assert.deepEqual(run.stats, [native], "the filesystem decision was reached once");
  assert.deepEqual(run.probes, ["claude", native]);
  assert.equal(run.command, native);
});

for (const [label, options] of [
  ["different uid", { uid: 1001 }],
  ["no owner execute bit", { mode: 0o100611 }],
  ["directory", { file: false }],
  ["missing file", { missing: true }],
]) {
  test(`native discovery rejects ${label} after reaching its file decision`, () => {
    const run = discoveryProbe(options);
    assert.deepEqual(run.stats, [join("/fixture/home", ".local", "bin", "claude")],
      "the candidate stat decision was reached");
    assert.deepEqual(run.probes, ["claude"], "an unsafe candidate is never executed");
    assert.equal(run.command, null);
  });
}

for (const [label, options] of [
  ["relative home", { home: "fixture/home" }],
  ["missing home", { home: null }],
  ["Linux", { platform: "linux" }],
  ["Windows", { platform: "win32" }],
]) {
  test(`native fallback is not searched for ${label}`, () => {
    const run = discoveryProbe(options);
    assert.deepEqual(run.probes, ["claude"], "PATH discovery reached the fallback boundary");
    assert.deepEqual(run.stats, []);
    assert.equal(run.command, null);
  });
}
