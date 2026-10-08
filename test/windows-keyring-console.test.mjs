import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatMessagesSync } from "esbuild";
import {
  askForTesting, closePromptsForTesting, cloudflareOAuthFailureMessage,
  cmdUpdate, openPromptsForTesting, promptsOpenForTesting, renderCliCommands,
  supportErrorCode, withCloudflareControlCredential,
} from "../brain.mjs";
import {
  enableCloudflareOAuthKeyring, captureCloudflareOAuthToken, cloudflareOAuthProfileName,
  isWindowsKeyringEnableTest, withCloudflareOAuthSession,
} from "../operations/cloudflare-oauth-session.mjs";
import { renderSupportRecovery, supportRecovery } from "../support-recovery.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

const COMMAND = "$env:CLOUDFLARE_AUTH_USE_KEYRING='true'; & npx.cmd --yes wrangler@4.131.1 auth keyring enable --env-file=NUL";
const CLEANUP = "Remove-Item Env:CLOUDFLARE_AUTH_USE_KEYRING";
const MISSING = "`@napi-rs/keyring` is required for OS keyring storage on Windows but is not installed.";
const accountId = "a".repeat(32);
const ok = () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });

function streams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  const output = new Writable({ write(_chunk, _encoding, next) { next(); } });
  output.isTTY = true;
  return { input, output };
}

for (const platformName of ["darwin", "linux", "win32"]) {
  test(`${platformName}: keyring uses the owner console only on interactive Windows`, () => {
    const { input, output } = streams();
    input.setRawMode(true);
    const events = [];
    let calls = 0;
    try {
      enableCloudflareOAuthKeyring({
        platformName, input, output, environment: {},
        suspendPrompts: () => { events.push("release"); return () => events.push("restore"); },
        processRunner: (_command, args, options) => {
          calls++;
          assert.equal(options.env.CLOUDFLARE_AUTH_USE_KEYRING, "true");
          assert.equal(args.at(-1), `--env-file=${platformName === "win32" ? "NUL" : "/dev/null"}`);
          if (platformName === "win32") {
            assert.equal(options.stdio, "inherit");
            assert.equal(input.isRaw, false);
            assert.equal(input.isPaused(), true);
            assert.deepEqual(events, ["release"]);
          } else {
            assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
            assert.deepEqual(events, []);
          }
          return ok();
        },
      });
      assert.equal(calls, 1);
      assert.equal(input.isRaw, true);
      assert.deepEqual(events, platformName === "win32" ? ["release", "restore"] : []);
    } finally { input.destroy(); output.destroy(); }
  });
}

for (const [reason, result] of [
  ["binding_missing", () => ({ status: 1, stderr: Buffer.from(MISSING) })],
  ["npx_unavailable", () => ({ status: null, error: Object.assign(new Error("private detail"), { code: "ENOENT" }) })],
  ["npx_unavailable", () => ({ status: 9009 })],
  ["timeout", () => ({ status: null, error: Object.assign(new Error("private detail"), { code: "ETIMEDOUT" }) })],
  ["other", () => ({ status: 1, stderr: Buffer.from("private detail") })],
]) {
  test(`non-interactive Windows classifies ${reason} before wiping output`, () => {
    let calls = 0;
    const failed = result();
    failed.stdout = Buffer.from("private detail");
    let refusal;
    assert.throws(() => enableCloudflareOAuthKeyring({
      platformName: "win32", input: { isTTY: false }, output: { isTTY: false }, environment: {},
      processRunner: (_command, args, options) => {
        calls++;
        assert.ok(args.includes("keyring"));
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        return failed;
      },
    }), (error) => {
      refusal = error;
      assert.equal(error.code, "CLOUDFLARE_KEYRING_UNAVAILABLE");
      assert.equal(error.reason, reason);
      assert.ok(error.message.includes(COMMAND));
      assert.ok(error.message.includes(CLEANUP));
      assert.doesNotMatch(error.message, /private detail/);
      return true;
    });
    assert.equal(calls, 1, "the actual keyring decision must be reached");
    assert.ok(failed.stdout.every((byte) => byte === 0));
    if (failed.stderr) assert.ok(failed.stderr.every((byte) => byte === 0));
    assert.ok(cloudflareOAuthFailureMessage(refusal, { platformName: "win32" }).includes(COMMAND));
    assert.equal(supportErrorCode(refusal), "CLOUDFLARE_KEYRING_UNAVAILABLE");
    enableCloudflareOAuthKeyring({
      platformName: "win32", input: { isTTY: false }, output: { isTTY: false }, environment: {},
      processRunner: () => { calls++; return ok(); },
    });
    assert.equal(calls, 2, "the same non-interactive path succeeds with the binding installed");
  });
}

test("CLI releases its real shared readline for keyring and restores the next question on failure", async () => {
  const { input, output } = streams();
  let calls = 0;
  let during, restored, answer;
  openPromptsForTesting({ input, output });
  try {
    await assert.rejects(withCloudflareControlCredential(() => assert.fail("action reached"), {
      authProfile: cloudflareOAuthProfileName("fixture-keyring-install-identity"),
      accountId, reauthorizeOAuth: true, interactive: true, platform: "win32",
      withOAuthSession: async (options) => {
        try { return await withCloudflareOAuthSession(options); }
        finally {
          restored = promptsOpenForTesting();
          if (restored) {
            const next = askForTesting("Continue?", "n");
            input.write("y\n");
            answer = await next;
          }
        }
      },
      oauthOptions: {
        platformName: "win32", input, output, environment: {},
        processRunner: (_command, _args, options) => {
          calls++;
          during = { prompts: promptsOpenForTesting(), raw: input.isRaw, stdio: options.stdio };
          return { status: 1 };
        },
      },
    }), (error) => error.code === "CLOUDFLARE_KEYRING_UNAVAILABLE");
    assert.equal(calls, 1);
    assert.deepEqual(during, { prompts: false, raw: false, stdio: "inherit" });
    assert.equal(restored, true, "keyring must restore readline before the outer CLI handles failure");
    assert.equal(answer, "y");
  } finally { closePromptsForTesting(); input.destroy(); output.destroy(); }
});

test("brain update preserves the reached keyring refusal and one runnable Windows next step", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-keyring-update-")));
  const manifestPath = join(root, "brain.manifest.json");
  const original = JSON.stringify({
    client: { slug: "fixture", display_name: "Fixture", timezone: "UTC" },
    brain: { version: "0.3.5", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: accountId, storage: "d1" } },
  });
  writeFileSync(manifestPath, original);
  let keyringCalls = 0, promptCalls = 0, actions = 0;
  const priorLog = console.log;
  console.log = () => {};
  const options = {
    installedManifestOptions: { home: root, stateDirectory: join(root, "installed-state") },
    interactive: true, askFn: async () => "y",
    authProfileAdoption: { env: {} },
    loadStoredCloudflareToken: () => null,
    readCloudflareToken: async () => { promptCalls++; throw new Error("fixture refused prompt"); },
    cmdVerify: async () => { actions++; }, cmdUpgrade: async () => { actions++; return "updated"; },
    installTechnicianSkills: () => [], reportSkillRefreshOk: () => {}, reportSkillRefreshWarning: () => {},
    oauthOptions: {
      platformName: "win32", input: { isTTY: false }, output: { isTTY: false }, environment: {},
      processRunner: (_command, args) => {
        keyringCalls++;
        assert.ok(args.includes("keyring"));
        return { status: 1, stderr: Buffer.from(MISSING) };
      },
    },
  };
  try {
    await assert.rejects(cmdUpdate(manifestPath, options), (error) => {
      assert.equal(error.code, "CLOUDFLARE_KEYRING_UNAVAILABLE");
      assert.ok(error.message.includes(COMMAND));
      assert.match(error.message, /binding_missing/);
      assert.equal(error.message.split(COMMAND).length, 2, "one runnable install command");
      assert.doesNotMatch(error.message, /hidden token entry|saved Cloudflare key/);
      return true;
    });
    assert.equal(keyringCalls, 1);
    assert.equal(promptCalls, 0);
    assert.equal(actions, 0);
    assert.equal(readFileSync(manifestPath, "utf8"), original);
    let adopted = 0;
    assert.equal(await cmdUpdate(manifestPath, {
      ...options,
      authProfileAdoption: { env: {}, withOAuthSession: async ({ profile }) => {
        adopted++; return { profile, account: { id: accountId } };
      } },
      withCloudflareControl: (action) => action(),
    }), "updated");
    assert.equal(adopted, 1);
    assert.equal(actions, 2, "green control reaches verify and upgrade");
  } finally { console.log = priorLog; rmSync(root, { recursive: true, force: true }); }
});

test("support explains all bounded keyring reasons and the exact Windows command", () => {
  const guide = supportRecovery("CLOUDFLARE_KEYRING_UNAVAILABLE");
  assert.ok(guide, "the typed issue must have a recovery catalog entry");
  const text = renderCliCommands(renderSupportRecovery(guide));
  for (const reason of ["binding_missing", "npx_unavailable", "timeout", "other"]) assert.ok(text.includes(reason));
  assert.ok(text.includes(COMMAND));
  assert.ok(text.includes(CLEANUP));
});

test("the fixed binding message survives Wrangler's error formatter", () => {
  const dist = readFileSync(new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url), "utf8");
  assert.ok(dist.includes(MISSING.replaceAll("`", "\\`")), "the classifier must match the reviewed dist message");
  for (const terminalWidth of [undefined, 80]) {
    const stderr = Buffer.from(formatMessagesSync([{ text: MISSING }], { kind: "error", color: true, terminalWidth })[0]);
    let calls = 0;
    assert.throws(() => enableCloudflareOAuthKeyring({
      platformName: "win32", input: { isTTY: false }, output: { isTTY: false }, environment: {},
      processRunner: () => { calls++; return { status: 1, stderr }; },
    }), (error) => error.reason === "binding_missing");
    assert.equal(calls, 1);
    assert.ok(stderr.every((byte) => byte === 0));
    enableCloudflareOAuthKeyring({ platformName: "win32", environment: {},
      processRunner: () => { calls++; return ok(); } });
    assert.equal(calls, 2);
  }
});

test("the real support CLI exposes the typed keyring recovery", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "brain-keyring-support-")));
  try {
    const result = spawnSync(process.execPath, [
      "--import", new URL("./fixtures/cli-side-effect-tripwire.mjs", import.meta.url).href,
      fileURLToPath(new URL("../brain.mjs", import.meta.url)),
      "support", "--explain", "CLOUDFLARE_KEYRING_UNAVAILABLE",
    ], { env: cliTestEnvironment(root), encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CLOUDFLARE_KEYRING_UNAVAILABLE/);
    assert.match(result.stdout, /binding_missing/);
    assert.ok(result.stdout.includes(COMMAND));
    assert.ok(result.stdout.includes(CLEANUP));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const code of ["ENOENT", "ETIMEDOUT", "UNREVIEWED"]) {
  test(`a thrown ${code} launcher error restores raw mode and retains only a safe reason`, () => {
    const { input, output } = streams();
    input.setRawMode(true);
    const events = [];
    let calls = 0;
    try {
      assert.throws(() => enableCloudflareOAuthKeyring({
        platformName: "win32", input, output, environment: {},
        suspendPrompts: () => { events.push("released"); return () => events.push("restored"); },
        processRunner: () => { calls++; throw Object.assign(new Error("private launcher detail"), { code }); },
      }), (error) => {
        assert.equal(error.reason, code === "ENOENT" ? "npx_unavailable" : code === "ETIMEDOUT" ? "timeout" : "other");
        assert.doesNotMatch(error.message, /private launcher detail|UNREVIEWED/);
        return true;
      });
      assert.equal(calls, 1);
      assert.deepEqual(events, ["released", "restored"]);
      assert.equal(input.isRaw, true);
      enableCloudflareOAuthKeyring({ platformName: "win32", input, output, environment: {},
        processRunner: () => { calls++; return ok(); } });
      assert.equal(calls, 2);
    } finally { input.destroy(); output.destroy(); }
  });
}

test("the CI keyring opt-in cannot permit auth token", () => {
  let reached = 0;
  const environment = { BRAIN_TEST_WINDOWS_KEYRING_ENABLE: "1" };
  Object.defineProperty(environment, "BRAIN_TEST_CHAIN", { get() { reached++; return "1"; } });
  assert.throws(() => captureCloudflareOAuthToken({
    profile: cloudflareOAuthProfileName("fixture-keyring-install-identity"),
    platformName: "win32", environment, allowWindowsKeyringEnableTest: true,
  }), /BRAIN_TEST_CHAIN refused real Wrangler authentication/);
  assert.ok(reached > 0);
});

test("the CI exception admits exactly the pinned Windows keyring subcommand", () => {
  const args = ["--yes", "wrangler@4.131.1", "auth", "keyring", "enable"];
  const options = { allowWindowsKeyringEnableTest: true, platformName: "win32", hostPlatform: "win32",
    environment: { BRAIN_TEST_WINDOWS_KEYRING_ENABLE: "1" } };
  assert.equal(isWindowsKeyringEnableTest(args, options), true, "green control reaches the exception");
  for (const refused of [args.slice(1), [...args, "--profile", "default"],
    ["--yes", "wrangler@4.131.1", "auth", "keyring", "disable"],
    ["--yes", "wrangler@4.131.1", "auth", "token"],
    ["--yes", "wrangler@4.131.1", "auth", "create", "default"],
    ["--yes", "wrangler@4.131.0", "auth", "keyring", "enable"]]) {
    assert.equal(isWindowsKeyringEnableTest(refused, options), false);
  }
  for (const change of [{ environment: {} }, { allowWindowsKeyringEnableTest: false },
    { platformName: "darwin" }, { hostPlatform: "darwin" }]) {
    assert.equal(isWindowsKeyringEnableTest(args, { ...options, ...change }), false);
  }
});

test("Windows CI runs the missing-binding arm and its real preinstalled CONTROL", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const start = workflow.indexOf("  windows-keyring:\n");
  assert.ok(start > 0);
  const end = workflow.indexOf("\n  history-privacy:", start);
  assert.ok(end > start);
  const job = workflow.slice(start, end);
  assert.match(job, /runs-on: windows-latest/);
  assert.match(job, /node: \['22', '24'\]/);
  for (const mode of ["missing", "control"]) {
    assert.ok(job.includes(`node test/windows-keyring-real.test.mjs --${mode}`));
  }
  assert.equal((job.match(/BRAIN_TEST_WINDOWS_KEYRING_ENABLE: '1'/g) ?? []).length, 2);
  assert.equal((job.match(/BRAIN_TEST_CHAIN: '1'/g) ?? []).length, 2);
  assert.doesNotMatch(job, /BRAIN_NO_WRANGLER_LOGIN:\s*|continue-on-error/);
  for (const action of job.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
