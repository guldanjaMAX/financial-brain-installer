import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cloudflareOAuthInstallIdentity, cmdUpdate as nativeUpdate, withCloudflareControlCredential } from "../brain.mjs";
import { isolateUpdateSchedulers } from "./fixtures/isolated-update-schedulers.mjs";
import {
  cloudflareOAuthProfileName, createCloudflareOAuthProfile,
} from "../operations/cloudflare-oauth-session.mjs";
import { launchWindowsCloudflareSignIn, WINDOWS_SIGNIN_EXIT, windowsUpdateStopMessage } from "../operations/windows-update-signin.mjs";
import { runWindowsCloudflareSignIn } from "../operations/windows-update-signin-cli.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const cmdUpdate = isolateUpdateSchedulers(nativeUpdate);
const profile = cloudflareOAuthProfileName("synthetic-install-identity");
const accountId = "a".repeat(32);
const ok = () => ({ status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
const omittedEnvironmentValue = ["must", "stay", "out"].join("-");

function authentication({ expired = true, windowStatus = 0, wrongAccount = false,
  alwaysExpired = false, keyringFails = false, vectorizeRefused = false, windowError = null } = {}) {
  const calls = [];
  const reads = [];
  let tokenReads = 0;
  const options = {
    platformName: "win32", windowsSignInWindow: true,
    input: { isTTY: false }, output: { isTTY: false },
    environment: { SystemRoot: "C:\\Windows", HOME: process.env.HOME,
      PATH: "/fixture/bin", ADMIN_KEY: omittedEnvironmentValue, NODE_OPTIONS: omittedEnvironmentValue,
      CLOUDFLARE_API_TOKEN: omittedEnvironmentValue, NPM_TOKEN: omittedEnvironmentValue },
    processRunner(command, args, child) {
      calls.push({ command, args, child });
      if (command.endsWith("powershell.exe")) {
        if (windowError) throw windowError;
        return { ...ok(), status: windowStatus };
      }
      if (keyringFails && args.includes("keyring") && calls.length === 1) return { ...ok(), status: 1 };
      if (args.includes("token")) {
        tokenReads++;
        if (alwaysExpired || (expired && tokenReads === 1)) return { ...ok(), status: 1 };
        return { ...ok(), stdout: Buffer.from(JSON.stringify({ type: "oauth",
          token: ["synthetic", "access", "material"].join("-").repeat(2) })) };
      }
      return ok();
    },
    async fetchImpl(url) {
      const path = new URL(url).pathname;
      reads.push(path);
      const id = wrongAccount ? "b".repeat(32) : accountId;
      const result = path.endsWith("/accounts") ? [{ id, name: "Selected" }]
        : path.endsWith(`/accounts/${accountId}`) ? { id, name: "Selected" } : [];
      const refused = vectorizeRefused && path.includes("/vectorize/");
      return new Response(JSON.stringify({ success: !refused, errors: [], messages: [], result,
        result_info: { page: 1, count: 1, total_count: 1, total_pages: 1 } }), { status: refused ? 403 : 200 });
    },
  };
  return { options, calls, reads };
}

test("background Windows authorization opens one new console without capturing its output", () => {
  const h = authentication();
  assert.equal(createCloudflareOAuthProfile({ profile, ...h.options }), profile);
  assert.equal(h.calls.length, 1, "one window owns keyring enable and browser sign-in together");
  const call = h.calls[0];
  assert.match(call.command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(call.child.shell, false);
  assert.equal(call.child.stdio, "ignore", "the updater must not capture the sign-in link or console output");
  assert.equal(call.child.env.ADMIN_KEY, undefined);
  assert.equal(call.child.env.NODE_OPTIONS, undefined);
  assert.doesNotMatch(JSON.stringify(call), /must-stay-out/);
  const script = Buffer.from(call.args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Start-Process/);
  assert.match(script, /-WindowStyle Normal/);
  assert.match(script, /-Wait/);
  assert.match(script, /-PassThru/);
  assert.doesNotMatch(script, /-Verb|-NoNewWindow|Bypass|RedirectStandard/);
});

function controlOptions(h) {
  return { platform: "win32", authProfile: profile, accountId, interactive: false,
    allowBrowserReauth: true, allowTokenRecovery: false, oauthOptions: h.options,
    askFn: () => assert.fail("background sign-in has no terminal question"),
    withToken: () => assert.fail("no recovery-token fallback") };
}

async function greenControl({ platformName = "win32", expired = true } = {}) {
  const h = authentication({ expired });
  h.options.platformName = platformName;
  let actions = 0;
  await withCloudflareControlCredential(() => { actions++; }, { ...controlOptions(h), platform: platformName });
  assert.equal(actions, 1, "the same harness admits a healthy control");
  assert.ok(h.reads.some(path => path.includes("/vectorize/")), "the control completes permission readback");
}

test("a valid background session is the green control and opens no sign-in window", async () => {
  const h = authentication({ expired: false });
  let actions = 0;
  await withCloudflareControlCredential(() => { actions++; }, controlOptions(h));
  assert.equal(actions, 1);
  assert.ok(h.reads.some(path => path.includes("/vectorize/")), "the green control reaches permission checks");
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 0);
});

for (const [label, fault] of [
  ["cancelled", { windowStatus: WINDOWS_SIGNIN_EXIT.unfinished }],
  ["protected storage refused", { windowStatus: WINDOWS_SIGNIN_EXIT.keyring }],
  ["cache write refused", { windowStatus: WINDOWS_SIGNIN_EXIT.workdir }],
  ["no new console", { windowStatus: WINDOWS_SIGNIN_EXIT.noConsole }],
  ["unknown exit", { windowStatus: null }],
  ["timeout", { windowError: Object.assign(new Error("private child failure"), { code: "ETIMEDOUT" }) }],
  ["launcher missing", { windowError: Object.assign(new Error("private child failure"), { code: "ENOENT" }) }],
]) test(`a ${label} sign-in window cannot start an update action`, async () => {
  const h = authentication(fault);
  let actions = 0;
  await assert.rejects(withCloudflareControlCredential(() => { actions++; }, controlOptions(h)));
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1,
    "the failed window decision was reached exactly once");
  assert.equal(h.calls.filter(call => call.args.includes("token")).length, 1,
    "no token read follows an unproved window outcome");
  assert.equal(actions, 0);
  await greenControl();
});

test("a successful window still refuses the wrong bound account", async () => {
  const h = authentication({ wrongAccount: true });
  let actions = 0;
  await assert.rejects(withCloudflareControlCredential(() => { actions++; }, controlOptions(h)),
    error => error.code === "CONFIG_INVALID");
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
  assert.equal(h.reads.filter(path => path.endsWith("/accounts")).length, 1,
    "the post-window account decision was reached");
  assert.equal(actions, 0);
  await greenControl();
});

test("a successful window without renewed access stops without opening a second window", async () => {
  const h = authentication({ alwaysExpired: true });
  let actions = 0;
  await assert.rejects(withCloudflareControlCredential(() => { actions++; }, controlOptions(h)),
    error => error.code === "AUTH_EXPIRED");
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
  assert.equal(h.calls.filter(call => call.args.includes("token")).length, 2, "renewal was checked after the window");
  assert.equal(actions, 0);
  await greenControl();
});

test("missing Windows keyring support gets the same one-window sign-in repair", async () => {
  const h = authentication({ expired: false, keyringFails: true });
  let actions = 0;
  await withCloudflareControlCredential(() => { actions++; }, controlOptions(h));
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
  assert.equal(actions, 1);
});

test("the pinned Vectorize limitation refuses before refresh or token fallback", async () => {
  const h = authentication({ expired: false, vectorizeRefused: true });
  let actions = 0;
  await assert.rejects(withCloudflareControlCredential(() => { actions++; }, controlOptions(h)),
    error => error.code === "REMOTE_PERMISSION_DENIED");
  assert.ok(h.reads.some(path => path.includes("/vectorize/")), "the scope decision was reached");
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 0);
  assert.equal(actions, 0);
  await greenControl({ expired: false });
});

test("an action's auth-shaped failure is never retried as sign-in", async () => {
  const h = authentication({ expired: false });
  let actions = 0;
  const failure = Object.assign(new Error("synthetic action refused"), { code: "AUTH_EXPIRED" });
  await assert.rejects(withCloudflareControlCredential(() => { actions++; throw failure; }, controlOptions(h)),
    error => error === failure);
  assert.equal(actions, 1, "the action decision was reached");
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 0);
  await greenControl({ expired: false });
});

for (const platformName of ["darwin", "linux"]) test(`${platformName} background refusal never opens a Windows console`, async () => {
  const h = authentication();
  h.options.platformName = platformName;
  let actions = 0;
  await assert.rejects(withCloudflareControlCredential(() => { actions++; }, {
    ...controlOptions(h), platform: platformName,
  }), error => error.code === "AUTH_EXPIRED");
  assert.equal(h.calls.filter(call => call.args.includes("token")).length, 1, "the expired-session decision was reached");
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 0);
  assert.equal(actions, 0);
  await greenControl({ platformName, expired: false });
});

test("a real Windows terminal retains its direct keyring and browser ceremony", () => {
  const h = authentication();
  h.options.input = { isTTY: true };
  h.options.output = { isTTY: true };
  assert.equal(createCloudflareOAuthProfile({ profile, ...h.options }), profile);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.command === "npx" && call.child.stdio === "inherit"));
  assert.ok(h.calls[0].args.includes("wrangler@4.131.1"));
  assert.ok(h.calls[1].args.includes(profile));
});

test("a real Windows terminal retains approval before an expired sign-in refresh", async () => {
  const h = authentication();
  h.options.input = { isTTY: true };
  h.options.output = { isTTY: true };
  let prompts = 0;
  let actions = 0;
  await withCloudflareControlCredential(() => { actions++; }, { ...controlOptions(h), interactive: true,
    askFn: () => { prompts++; return "y"; },
  });
  assert.equal(prompts, 1);
  assert.equal(actions, 1);
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 0);
  assert.equal(h.calls.filter(call => call.args.includes("create")).length, 1);
});

test("the console child runs only pinned keyring enable and the exact profile browser sign-in", () => {
  const h = authentication();
  const output = [];
  const tty = { isTTY: true, write: line => output.push(line) };
  const status = runWindowsCloudflareSignIn([profile], { platformName: "win32", input: tty, output: tty,
    environment: h.options.environment,
    authorize: request => createCloudflareOAuthProfile({ ...request, processRunner: h.options.processRunner }),
  });
  assert.equal(status, 0);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.command === "npx" && call.args.includes("wrangler@4.131.1")));
  assert.ok(h.calls.every(call => call.child.stdio === "inherit"));
  assert.ok(h.calls.every(call => call.child.windowsHide === false));
  assert.deepEqual(h.calls.map(call => call.args.slice(call.args.indexOf("auth") + 1, call.args.indexOf("auth") + 3)),
    [["keyring", "enable"], ["create", profile]]);
  assert.ok(h.calls[1].args.includes("--browser"));
  assert.ok(h.calls[1].args.includes("--env-file=NUL"));
  assert.ok(h.calls[1].args.includes("--callback-port") && h.calls[1].args.includes("8976"));
  assert.ok(h.calls.every(call => !call.args.includes("token")));
  assert.equal(output.length, 1);
});

test("console child refusals return only closed status codes without raw errors", () => {
  for (const [code, status] of [["CLOUDFLARE_KEYRING_UNAVAILABLE", WINDOWS_SIGNIN_EXIT.keyring],
    ["CLOUDFLARE_OAUTH_WORKDIR_UNWRITABLE", WINDOWS_SIGNIN_EXIT.workdir],
    ["CLOUDFLARE_OAUTH_REAUTH_REQUIRED", WINDOWS_SIGNIN_EXIT.unfinished],
    ["unexpected", WINDOWS_SIGNIN_EXIT.unavailable], ["__proto__", WINDOWS_SIGNIN_EXIT.unavailable],
    ["constructor", WINDOWS_SIGNIN_EXIT.unavailable]]) {
    let reached = 0;
    const output = [];
    const tty = { isTTY: true, write: line => output.push(line) };
    assert.equal(runWindowsCloudflareSignIn([profile], { platformName: "win32", input: tty, output: tty,
      authorize: () => { reached++; throw Object.assign(new Error("private exception material"), { code }); },
    }), status);
    assert.equal(reached, 1);
    assert.doesNotMatch(output.join(""), /private exception/);
    assert.equal((output.join("").match(/Click /g) || []).length, 1);
    assert.equal(runWindowsCloudflareSignIn([profile], { platformName: "win32", input: tty, output: tty,
      authorize: () => { reached++; },
    }), 0, "the same console accepts a successful ceremony");
    assert.equal(reached, 2);
  }
});

test("a child without a real console refuses before any credential ceremony", () => {
  let ttyChecks = 0;
  let ceremonies = 0;
  const input = { get isTTY() { ttyChecks++; return false; } };
  assert.equal(runWindowsCloudflareSignIn([profile], { platformName: "win32", input,
    output: { isTTY: false }, authorize: () => { ceremonies++; },
  }), WINDOWS_SIGNIN_EXIT.noConsole);
  assert.equal(ttyChecks, 1, "the actual console decision was reached");
  assert.equal(ceremonies, 0);
  assert.equal(runWindowsCloudflareSignIn([profile], { platformName: "win32",
    input: { isTTY: true }, output: { isTTY: true, write() {} }, authorize: () => { ceremonies++; },
  }), 0);
  assert.equal(ceremonies, 1, "a real console is the green control");
});

test("the window launcher quotes paths as data and omits elevation or policy bypass", () => {
  const calls = [];
  assert.equal(launchWindowsCloudflareSignIn({ profile,
    nodePath: "C:\\Owner's runtime & tools\\node.exe",
    workingDirectory: "C:\\Owner's Brain $() & tools", environment: { SystemRoot: "C:\\Windows" },
    processRunner: (command, args, child) => { calls.push({ command, args, child }); return ok(); },
  }).status, 0);
  assert.equal(calls.length, 1);
  const script = Buffer.from(calls[0].args.at(-1), "base64").toString("utf16le");
  assert.ok(script.includes("-FilePath 'C:\\Owner''s runtime & tools\\node.exe'"));
  assert.ok(script.includes("-WorkingDirectory 'C:\\Owner''s Brain $() & tools'"));
  assert.doesNotMatch(script, /-Verb|-NoNewWindow|Bypass|RedirectStandard/);
});

test("an omitted test launcher is stopped before any host process", () => {
  assert.throws(() => launchWindowsCloudflareSignIn({ profile,
    workingDirectory: tmpdir(), environment: { SystemRoot: "C:\\Windows", BRAIN_TEST_CHAIN: "1" },
  }), /BRAIN_TEST_CHAIN refused/);
  let calls = 0;
  assert.equal(launchWindowsCloudflareSignIn({ profile, workingDirectory: tmpdir(),
    environment: { SystemRoot: "C:\\Windows", BRAIN_TEST_CHAIN: "1" },
    processRunner: () => { calls++; return ok(); },
  }).status, 0);
  assert.equal(calls, 1, "an injected launcher is the safe green control");
});

test("Windows stop copy has one real click, no commands, and no raw exception text", () => {
  for (const error of [{ code: "AUTH_EXPIRED" }, { code: "AUTH_REQUIRED" },
    { code: "CLOUDFLARE_KEYRING_UNAVAILABLE" }, { code: "REMOTE_PERMISSION_DENIED" },
    { code: "UPDATE_BRAIN_BUSY" }, { name: "WindowsDailyTaskRepairRequired" },
    { message: "private failure details" }]) {
    const message = windowsUpdateStopMessage(error);
    assert.equal((message.match(/Click /g) || []).length, 1);
    assert.match(message, /Keep any saved checkpoint/);
    assert.doesNotMatch(message, /private failure|\brun\b|\btype\b|\bnpx\b|\bPowerShell\b|\bbrain\s+update\b|\bwrangler\s+login\b/i);
  }
});

test("an expired background Windows session resumes once after exact profile and account readback", async () => {
  const h = authentication();
  let actions = 0;
  const result = await withCloudflareControlCredential(() => { actions++; return "continued"; }, {
    platform: "win32", authProfile: profile, accountId, interactive: false,
    allowBrowserReauth: true, allowTokenRecovery: false, oauthOptions: h.options,
    askFn: () => assert.fail("a background update cannot ask a terminal question"),
    withToken: () => assert.fail("sign-in must never fall back to token entry"),
  });
  assert.equal(result, "continued");
  assert.equal(actions, 1);
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
  assert.ok(h.reads.some(path => path.endsWith(`/accounts/${accountId}`)), "exact-account readback was reached");
  assert.ok(h.reads.some(path => path.includes("/vectorize/")), "the permission preflight still runs");
  const tokenCalls = h.calls.filter(call => call.args.includes("token"));
  assert.equal(tokenCalls.length, 2, "the window exit alone is not proof of renewed access");
  assert.ok(tokenCalls.every(call => call.args.includes(profile)), "the exact saved profile is preserved");
});

function updateFixture(t, h, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "windows-update-signin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "home"));
  const path = join(root, "brain.manifest.json");
  const keyPath = join(root, "fixture-admin");
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(path, JSON.stringify({ client: { slug: "fixture" },
    brain: { version: "0.4.8", domain: "brain.example.invalid" },
    infrastructure: { cloudflare: { account_id: accountId, auth_profile: profile,
      storage: "d1", d1_database_id: "fixture-database", vectorize_index: "fixture-index" } },
    corpora: {}, operations: { admin_key_secret: `file://${keyPath}` } }));
  const before = readFileSync(path, "utf8");
  // The production command, rather than the fixture, must authorize the window.
  delete h.options.windowsSignInWindow;
  const stages = [];
  const finish = [];
  const options = {
    platform: "win32", interactive: false, oauthOptions: h.options,
    discoverInstalledManifest: () => ({ path, source: "remembered" }),
    claudeSkillOptions: { home: join(root, "home") },
    adoptCloudflareAuthProfile: async () => profile,
    cmdVerify: async () => stages.push("verify"),
    cmdUpgrade: async () => { stages.push("upgrade"); return { status: "verified" }; },
    reportUpdateFinish: line => finish.push(line),
    askFn: () => assert.fail("no terminal question"),
    ...overrides,
  };
  return { path, before, stages, finish, options };
}

test("the real background update enables the visible sign-in route and continues the same update", async t => {
  const h = authentication();
  const f = updateFixture(t, h);
  await cmdUpdate(f.path, f.options);
  assert.deepEqual(f.stages, ["verify", "upgrade"]);
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
  assert.equal(readFileSync(f.path, "utf8"), f.before, "sign-in does not rewrite the manifest");
  assert.equal(f.finish.length, 1);
});

for (const fault of ["cancel", "account", "permission"]) test(`the real update preserves its manifest and one-click stop after ${fault} refusal`, async t => {
  const h = authentication(fault === "cancel" ? { windowStatus: WINDOWS_SIGNIN_EXIT.unfinished }
    : fault === "account" ? { wrongAccount: true } : { vectorizeRefused: true });
  const f = updateFixture(t, h);
  await assert.rejects(cmdUpdate(f.path, f.options), error => {
    assert.match(error.ownerMessage, /Click back into this assistant conversation/);
    assert.equal((error.ownerMessage.match(/Click /g) || []).length, 1);
    assert.doesNotMatch(error.ownerMessage, /\brun\b|\btype\b|\bnpx\b/i);
    assert.ok(error.code, "the original support classification survives owner-copy rendering");
    return true;
  });
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1,
    "each refusal reached the actual new-window boundary");
  assert.deepEqual(f.stages, []);
  assert.deepEqual(f.finish, []);
  assert.equal(readFileSync(f.path, "utf8"), f.before);
  const control = updateFixture(t, authentication());
  await cmdUpdate(control.path, control.options);
  assert.deepEqual(control.stages, ["verify", "upgrade"]);
});

test("a Windows task-safety stop preserves its diagnosis and gives the owner one click", async t => {
  const h = authentication({ expired: false });
  const diagnostic = new Error("The Task Scheduler task could not be read back; retry the update.");
  diagnostic.name = "WindowsDailyTaskRepairRequired";
  diagnostic.supportCode = "SAFETY_REVIEW_REQUIRED";
  let inspected = 0;
  const f = updateFixture(t, h, { cmdVerify: async () => { inspected++; throw diagnostic; } });
  await assert.rejects(cmdUpdate(f.path, f.options), error => {
    assert.equal(error, diagnostic);
    assert.equal(error.supportCode, "SAFETY_REVIEW_REQUIRED");
    assert.match(error.message, /could not be read back/);
    assert.match(error.ownerMessage, /Task Scheduler/);
    assert.equal((error.ownerMessage.match(/Click /g) || []).length, 1);
    return true;
  });
  assert.equal(inspected, 1, "the safety decision was reached after authentication");
  assert.deepEqual(f.stages, []);
  assert.deepEqual(f.finish, []);
  const control = updateFixture(t, authentication({ expired: false }));
  await cmdUpdate(control.path, control.options);
  assert.deepEqual(control.stages, ["verify", "upgrade"]);
});

test("Windows sign-in precedes the answer-key gate, and missing keys still stop before update work", async t => {
  for (const keyPresent of [false, true]) {
    const h = authentication();
    const f = updateFixture(t, h);
    const manifest = JSON.parse(f.before);
    manifest.retrieval = { answer_model: "claude-opus-5-5", gate_model: "claude-sonnet-5-5" };
    writeFileSync(f.path, JSON.stringify(manifest));
    const before = readFileSync(f.path, "utf8");
    let keyReads = 0;
    f.options.answerKeyOptions = { cf: async path => {
      keyReads++;
      assert.equal(path, `/accounts/${accountId}/workers/scripts/fixture-brain/secrets`);
      assert.ok(h.reads.some(value => value.includes("/vectorize/")), "sign-in and permissions precede key-name inspection");
      return keyPresent ? [{ name: "ANTHROPIC_API_KEY" }] : [];
    } };
    if (keyPresent) {
      await cmdUpdate(f.path, f.options);
      assert.deepEqual(f.stages, ["verify", "upgrade"], "the present-key arm is the green update control");
    } else {
      await assert.rejects(cmdUpdate(f.path, f.options), error => {
        assert.match(error.message, /Anthropic key.*missing/);
        assert.match(error.ownerMessage, /Click back into this assistant conversation/);
        return true;
      });
      assert.deepEqual(f.stages, []);
      assert.deepEqual(f.finish, []);
    }
    assert.equal(keyReads, 1, "both arms reach the exact key-name decision");
    assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
    assert.equal(readFileSync(f.path, "utf8"), before);
  }
});

test("explicitly approved background profile adoption uses the console and records only verified custody", async t => {
  const h = authentication({ expired: false });
  const lines = [];
  const f = updateFixture(t, h, { adoptConsent: true,
    authProfileAdoption: { env: {}, write: line => lines.push(line) } });
  delete f.options.adoptCloudflareAuthProfile;
  const manifest = JSON.parse(f.before);
  delete manifest.infrastructure.cloudflare.auth_profile;
  writeFileSync(f.path, JSON.stringify(manifest));
  await cmdUpdate(f.path, f.options);
  assert.equal(h.calls.filter(call => call.command.endsWith("powershell.exe")).length, 1);
  assert.deepEqual(f.stages, ["verify", "upgrade"]);
  const saved = JSON.parse(readFileSync(f.path, "utf8")).infrastructure.cloudflare;
  assert.equal(saved.auth_profile, cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(f.path)));
  assert.equal(saved.auth_profile_consent, "non-interactive");
  assert.equal(saved.account_id, accountId);
  assert.match(lines.join("\n"), /separate Financial Brain sign-in window/);
  assert.doesNotMatch(lines.join("\n"), /sign-in URL printed below|\bnpx\b/);
});

test("the real Windows CLI preserves option guidance when dispatch refuses before the update starts", t => {
  const root = mkdtempSync(join(tmpdir(), "windows-update-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "fixture-admin"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const args = [
    "--import", new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href,
    "--import", new URL("./fixtures/isolate-support-root.mjs", import.meta.url).href,
    "--import", new URL("./fixtures/support-journal-acl-preload.mjs", import.meta.url).href,
    "--import", "data:text/javascript," + encodeURIComponent('Object.defineProperty(process, "platform", { value: "win32" });'),
    fileURLToPath(new URL("../brain.mjs", import.meta.url)), "update",
  ];
  const options = { cwd: root, env: cliTestEnvironment(root), encoding: "utf8", timeout: 15_000 };
  const refused = spawnSync(process.execPath, [...args, "--synthetic-unsupported"], options);
  assert.equal(refused.status, 1, refused.stderr);
  const output = refused.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(output, /\bfail\b/, "the real dispatch refusal reached the CLI's failure renderer");
  assert.doesNotMatch(refused.stdout + refused.stderr, /TEST_SIDE_EFFECT_BLOCKED/);
  assert.match(output, /doesn't take --synthetic-unsupported\./);
  assert.match(output, /with no options\./);
  assert.doesNotMatch(output, /Click back|The update is incomplete|saved checkpoint|\bnpx\b/i);
  const control = spawnSync(process.execPath, [...args, "--help"], options);
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout, /Updates the installed Brain/, "the same safe CLI launch reaches the help control");
});
