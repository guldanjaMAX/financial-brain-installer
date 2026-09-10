import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cmdLocalTools, cmdTechnician, VALUE_FLAGS } from "../brain.mjs";
import { WRANGLER_PACKAGE } from "../doctor.mjs";

import {
  TECHNICIAN_RUN_STEPS,
  runTechnicianStep,
  technicianChildEnvironment,
  technicianPlan,
} from "../operations/technician-setup.mjs";
import {
  CLAUDE_WORKSPACE_MARKER,
  writeClaudeWorkspaceGuide,
} from "../operations/claude-workspace.mjs";
import {
  CLAUDE_TECHNICIAN_SKILL_MARKER,
  installClaudeTechnicianSkill,
} from "../operations/claude-skill.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

// The installer renders every `brain <subcommand>` in the packaged skill for the
// machine it lands on: identity on macOS and Linux, a runnable invocation of the
// real executable on Windows. Build the expectations through the same renderer
// so each one keeps asserting the exact command, on either platform, instead of
// asserting the POSIX spelling that only one of them produces.
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const renderedCommand = (text) => escapeForRegExp(renderCliCommands(text));

const sandbox = mkdtempSync(join(tmpdir(), "brain-technician-test-"));
const manifestPath = join(sandbox, "brain.manifest.json");
const fixtureScriptPath = resolve("/fixture/brain.mjs");
const fixtureNodePath = resolve("/fixture/node");
const safeBrainPath = resolve("/safe/lib/brain.mjs");
const safeNodePath = resolve("/safe/bin/node");
writeFileSync(manifestPath, JSON.stringify({
  client: { slug: "fixture" },
  brain: { domain: "brain.fixture.test" },
  corpora: {
    google_drive: { enabled: true },
    gmail: { enabled: true },
    calendar: { enabled: true },
    zoom: { enabled: true },
    imap: { enabled: true },
    bank_feed: {
      enabled: true,
      provider: "plaid",
      environment: "production",
      registered_redirect_uris: ["https://brain.fixture.test/app/connect/bank"],
      registered_webhook_uris: ["https://brain.fixture.test/api/webhooks/plaid"],
    },
  },
}));

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

for (const platformName of ["darwin", "win32"]) test(`local tool readiness proves Claude sign-in, pinned Wrangler, and the interactive Claude doctor on ${platformName}`, async () => {
  const calls = [];
  const skillHome = join(sandbox, `local-tools-home-${platformName}`);
  const environment = platformName === "win32"
    ? { USERPROFILE: "C:\\Users\\fixture", PATH: "C:\\Users\\fixture\\.local\\bin", SystemRoot: "C:\\Windows" }
    : { HOME: skillHome, PATH: "/usr/bin:/bin" };
  let dpapiProbes = 0;
  const receipt = await cmdLocalTools({
    isTTY: true,
    platformName,
    environment,
    existsImpl: path => path === "C:\\Users\\fixture\\.local\\bin\\claude.exe",
    dpapiProbe: options => {
      dpapiProbes++;
      assert.equal(options.platform, "win32");
      assert.equal(options.rounds, 25);
      return { checked: true, passed: true, rounds: 25, cleanup_status: "clean" };
    },
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      // 4.127+ is the floor now: isolated Wrangler auth profiles need it, and
      // the version the fixture reports is the version the check judges.
      if (command === "npx") return { ok: true, out: "wrangler 4.127.1" };
      if (args[0] === "--version") return { ok: true, out: "2.1.63 (Claude Code)" };
      if (args.join(" ") === "auth status") return { ok: true, out: "fixture status intentionally hidden" };
      return { ok: false, out: "unexpected fixture command" };
    },
    runClaudeDoctor: async () => ({ status: 0 }),
    claudeSkillOptions: { home: skillHome },
  });
  assert.deepEqual(receipt, {
    claude: "ready",
    wrangler: "ready",
    technician_skill: "installed",
    claude_doctor: "passed",
    ...(platformName === "win32" ? { claude_path: "verified" } : {}),
  });
  assert.equal(dpapiProbes, platformName === "win32" ? 1 : 0);
  assert.ok(calls.some((call) => call.command === "claude" && call.args.join(" ") === "auth status"));
  assert.ok(calls.some((call) => call.command === "npx" &&
    call.args.join(" ") === `${WRANGLER_PACKAGE} --version`));
  assert.ok(calls.every((call) => call.options.inheritEnv === false));
});

test("the personal Claude technician skill installs exactly, verifies on rerun, and contains no credential", () => {
  const home = join(sandbox, "skill-home");
  const first = installClaudeTechnicianSkill({ home });
  assert.equal(first.status, "installed");
  const content = readFileSync(first.path, "utf8");
  assert.match(content, new RegExp(CLAUDE_TECHNICIAN_SKILL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, /\/financial-brain-technician/);
  assert.match(content, /In Codex,\s+use `\$financial-brain-technician`/);
  assert.ok(content.includes(renderCliCommands("brain technician")),
    "the installed skill must name the technician entrypoint");
  const updateRouteStart = content.indexOf("## Route an update request first");
  const setupRouteStart = content.indexOf("## Start here");
  const releaseManifest = content.indexOf("https://financialbrain.ai/update/manifest.json");
  const agentPlaybook = content.indexOf("https://financialbrain.ai/update/agent.md");
  const updateEntrypoint = content.indexOf(renderCliCommands("brain update [manifest]"));
  assert.ok(updateRouteStart > 0, "installed skill must route explicit Brain update requests");
  assert.ok(setupRouteStart > updateRouteStart, "update routing must run before the setup-oriented plan");
  assert.ok(releaseManifest > updateRouteStart && releaseManifest < agentPlaybook,
    "the held release feed must be the first live update decision");
  assert.ok(agentPlaybook < updateEntrypoint,
    "package-specific live guidance must be loaded before the update entrypoint is used");
  const updateRoute = content.slice(updateRouteStart, setupRouteStart);
  assert.match(updateRoute, /stop without a\s+change/i);
  assert.match(updateRoute, /nothing for the owner to collect/i);
  assert.match(updateRoute,
    new RegExp(`${renderedCommand("brain technician")}.*no update step`, "is"));
  assert.match(updateRoute, /preserve.*saved update checkpoint/is);
  assert.match(updateRoute, /documented package-pinned browser-login command/);
  assert.match(updateRoute, /preserving any account or isolated-profile options/);
  assert.match(updateRoute, /exact released CLI's guidance and matching live playbook/);
  assert.doesNotMatch(updateRoute, /wrangler@\d/,
    "the shared skill must not retain an older release's authentication pin");
  assert.match(updateRoute, /do not ask the owner\s+for a folder ID/i);
  assert.match(updateRoute, /no folder picker/i);
  assert.match(updateRoute, /twenty\s+minutes with unchanged counts.*wait, not a\s+stall/is);
  assert.match(updateRoute, /failed mandatory proof means the\s+update is incomplete/is);
  assert.doesNotMatch(updateRoute, /preflight\.(?:sh|ps1)/i,
    "an update must not route through a separate preflight script");
  assert.match(content, /package-pinned browser login.*needs no generic second approval/is);
  assert.match(content, /unchanged counts alone are\s+inconclusive/i);
  assert.doesNotMatch(content, /next release clears/i);
  assert.match(content, /set up, install, update, check, test a connector, complete a passkey step, or hand off/i);
  assert.match(content, new RegExp(
    `existing-Brain checkup, start with \`${renderedCommand("brain doctor <manifest>")}\``, "i"));
  assert.match(content, /for every non-update route, finish with the preflight/i);
  assert.doesNotMatch(content, /CLOUDFLARE_API_TOKEN|ADMIN_KEY|client_secret|app_password/);
  if (process.platform === "win32") assert.equal(statSync(first.path).isFile(), true);
  else assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(installClaudeTechnicianSkill({ home }), {
    path: first.path,
    status: "verified",
    changed: false,
  });
});

test("an unrelated personal Claude skill with the same name is preserved byte-for-byte", () => {
  const home = join(sandbox, "skill-collision-home");
  const target = join(home, ".claude", "skills", "financial-brain-technician", "SKILL.md");
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, "owner skill\n");
  assert.throws(() => installClaudeTechnicianSkill({ home }), /different personal skill/);
  assert.equal(readFileSync(target, "utf8"), "owner skill\n");
});

test("setup can create an owner-only Claude workspace guide with locators but no credentials", () => {
  const workspace = join(sandbox, "claude-workspace");
  mkdirSync(workspace);
  const manifest = join(workspace, "brain.manifest.json");
  writeFileSync(manifest, "{}");
  const first = writeClaudeWorkspaceGuide(manifest, {
    brainCliPath: safeBrainPath,
    nodePath: safeNodePath,
  });
  const content = readFileSync(first.path, "utf8");
  assert.equal(first.status, "written");
  assert.ok(content.startsWith(CLAUDE_WORKSPACE_MARKER));
  assert.ok(content.includes(`${JSON.stringify(safeNodePath)} ${JSON.stringify(safeBrainPath)}`));
  assert.match(content, /claude --add-dir <approved-folder>/);
  assert.match(content, /npx wrangler@4/);
  assert.match(content, /normal approval prompts enabled/i);
  assert.doesNotMatch(content, /CLOUDFLARE_API_TOKEN|ADMIN_KEY|client_secret|app_password/);
  // POSIX mode bits can prove the owner-only file mode directly. Windows does
  // not represent its inherited user-profile ACL in stat().mode and reports
  // 0666 even after chmodSync(0600); the guide contains locators and safety
  // rules only, never credentials or source content.
  if (process.platform === "win32") assert.equal(statSync(first.path).isFile(), true);
  else assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(
    writeClaudeWorkspaceGuide(manifest, {
      brainCliPath: safeBrainPath,
      nodePath: safeNodePath,
    }).status,
    "verified",
  );
});

test("an unrelated Claude workspace guide is preserved byte-for-byte", () => {
  const workspace = join(sandbox, "existing-claude-workspace");
  mkdirSync(workspace);
  const manifest = join(workspace, "brain.manifest.json");
  const target = join(workspace, "CLAUDE.md");
  writeFileSync(manifest, "{}");
  writeFileSync(target, "owner instructions\n");
  const result = writeClaudeWorkspaceGuide(manifest, { brainCliPath: "/safe/bin/brain" });
  assert.equal(result.status, "preserved_unrelated_existing_file");
  assert.equal(readFileSync(target, "utf8"), "owner instructions\n");
});

test("the plan is read-only, ordered, honest about proof, and agent-readable", () => {
  const missing = join(sandbox, "not-created.json");
  const plan = technicianPlan(missing);
  assert.equal(plan.mode, "read_only_plan");
  assert.equal(plan.proof_level, "workflow_only");
  assert.deepEqual(plan.steps.map((step) => step.id), TECHNICIAN_RUN_STEPS);
  assert.equal(plan.steps[0].state, "ready_to_start");
  assert.equal(plan.steps[1].state, "ready_after_local_tools");
  assert.match(plan.warning, /Live proof arrives/i);
  assert.match(JSON.stringify(plan), /hidden terminal prompts/i);
  assert.doesNotMatch(JSON.stringify(plan), /client_secret|app_password|api_token/i);

  const configured = technicianPlan(manifestPath, {
    cli: { command: safeNodePath, args: [safeBrainPath] },
  });
  const plaid = configured.steps.find((candidate) => candidate.id === "plaid");
  assert.equal(plaid.command, null);
  assert.equal(plaid.owner_only_command.execution_boundary, "owner_direct_terminal");
  assert.equal(plaid.owner_only_command.must_run_in_direct_owner_terminal, true);
  assert.deepEqual(plaid.owner_only_command.args, [
    safeBrainPath,
    "technician", manifestPath, "--run", "plaid",
    "--confirm-environment", "production",
    "--confirm-redirect", "https://brain.fixture.test/app/connect/bank",
    "--confirm-webhook", "https://brain.fixture.test/api/webhooks/plaid",
    "--confirm-single-setup-machine",
    "--confirm-production-access",
  ]);
  for (const flag of ["confirm-environment", "confirm-redirect", "confirm-webhook"]) {
    assert.equal(VALUE_FLAGS.has(flag), true, `--${flag} must refuse when its value is missing`);
  }
});

test("the first technician step verifies local tools before any manifest or account exists", async () => {
  let call;
  const receipt = await runTechnicianStep({
    step: "tools",
    manifestPath: join(sandbox, "not-created.json"),
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    spawn: (node, args, options) => { call = { node, args, options }; return { status: 0 }; },
  });
  assert.deepEqual(receipt, { step: "tools", completed: true, commands_run: 1 });
  assert.deepEqual(call.args, [fixtureScriptPath, "tools"]);
  assert.equal(call.options.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("the smoke step runs only the injected deployed proof contract", async () => {
  let request = null;
  let childCalls = 0;
  const proof = Object.freeze({
    install_smoke_documents: 1,
    checked_via: "deployed_authenticated_ingest",
    stored_identifiers: false,
  });
  const receipt = await runTechnicianStep({
    step: "smoke",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    spawn: () => { childCalls++; return { status: 0 }; },
    runInstallSmoke: async (value) => { request = value; return proof; },
  });
  assert.deepEqual(request, { manifestPath });
  assert.equal(childCalls, 0);
  assert.deepEqual(receipt, {
    step: "smoke",
    completed: true,
    commands_run: 0,
    proof_level: "live_data_plane_postconditions",
    proof,
  });

  await assert.rejects(
    runTechnicianStep({
      step: "smoke",
      manifestPath,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
    }),
    (error) => error.code === "install_smoke_runner_unavailable" && /No source proof was created/i.test(error.message),
  );
});

test("the child environment strips ambient credentials and unrelated application state", () => {
  const env = technicianChildEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    CLOUDFLARE_API_TOKEN: "must-not-cross",
    OPENAI_API_KEY: "must-not-cross",
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    GOOGLE_CLIENT_SECRET: "must-not-cross",
    ZOOM_CLIENT_SECRET: "must-not-cross",
    RANDOM_APPLICATION_VALUE: "must-not-cross",
  });
  assert.deepEqual(env, { PATH: "/safe/bin", HOME: "/safe/home", LANG: "en_US.UTF-8" });
  assert.doesNotMatch(JSON.stringify(env), /must-not-cross/);
});

test("Google credentials cross only the child environment, never argv, and input buffers are zeroed", async () => {
  const clientId = Buffer.from("fixture-google-client-id");
  const clientSecret = Buffer.from("fixture-google-client-secret");
  const entered = [clientId, clientSecret];
  const calls = [];
  const receipt = await runTechnicianStep({
    step: "google",
    manifestPath,
    flags: {},
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "ambient-secret" },
    readHidden: async () => entered.shift(),
    spawn: (node, args, options) => {
      calls.push({ node, args, options });
      assert.equal(options.env.GOOGLE_CLIENT_ID, "fixture-google-client-id");
      assert.equal(options.env.GOOGLE_CLIENT_SECRET, "fixture-google-client-secret");
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(receipt, { step: "google", completed: true, commands_run: 1 });
  assert.deepEqual(calls[0].args, [fixtureScriptPath, "connect", "google", "--scopes", "drive,gmail,calendar"]);
  assert.doesNotMatch(calls[0].args.join(" "), /fixture-google/);
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_ID, "");
  assert.equal(calls[0].options.env.GOOGLE_CLIENT_SECRET, "");
  assert.ok(clientId.every((byte) => byte === 0));
  assert.ok(clientSecret.every((byte) => byte === 0));
});

test("Zoom collects the exact S2S values, strips ambient secrets, and zeroes every input", async () => {
  const values = [
    Buffer.from("fixture-account"),
    Buffer.from("fixture-client"),
    Buffer.from("fixture-client-secret"),
    Buffer.from("fixture-webhook-secret"),
  ];
  const originals = [...values];
  let call;
  await runTechnicianStep({
    step: "zoom",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", BANK_FEED_SECRET: "ambient-bank-secret" },
    readHidden: async () => values.shift(),
    spawn: (node, args, options) => {
      call = { node, args, options };
      assert.deepEqual(
        Object.keys(options.env).filter((key) => key.startsWith("ZOOM_")).sort(),
        ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"],
      );
      assert.equal(options.env.BANK_FEED_SECRET, undefined);
      return { status: 0 };
    },
  });
  assert.deepEqual(call.args, [fixtureScriptPath, "connect", "zoom", manifestPath]);
  assert.doesNotMatch(call.args.join(" "), /fixture-account|fixture-client|fixture-webhook/);
  for (const key of ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"]) {
    assert.equal(call.options.env[key], "");
  }
  for (const buffer of originals) assert.ok(buffer.every((byte) => byte === 0));
});

test("IMAP passes only non-secret routing values and leaves app-password prompting to the connector", async () => {
  let call;
  await runTechnicianStep({
    step: "imap",
    manifestPath,
    flags: { host: "imap.example.test", user: "owner@example.test", port: "993", source: "owner-mail" },
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", IMAP_PASSWORD: "ambient-secret" },
    spawn: (node, args, options) => { call = { node, args, options }; return { status: 0 }; },
  });
  assert.deepEqual(call.args, [
    fixtureScriptPath, "connect", "imap", manifestPath,
    "--host", "imap.example.test", "--user", "owner@example.test",
    "--port", "993", "--source", "owner-mail",
  ]);
  assert.equal(call.options.env.IMAP_PASSWORD, undefined);
  assert.doesNotMatch(JSON.stringify(call), /ambient-secret/);
});

test("Plaid refuses before hidden entry unless environment, URLs, and Production access are exact", async () => {
  let hiddenReads = 0;
  let setupCalls = 0;
  const common = {
    step: "plaid",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    readHidden: async () => { hiddenReads++; return Buffer.from("must-not-be-read"); },
    runPlaidSetup: async () => { setupCalls++; return {}; },
  };
  await assert.rejects(
    runTechnicianStep({ ...common, flags: {} }),
    /confirm-environment.*production/i,
  );
  await assert.rejects(
    runTechnicianStep({
      ...common,
      flags: {
        "confirm-environment": "production",
        "confirm-redirect": "https://wrong.fixture.test/app/connect/bank",
      },
    }),
    /confirm-redirect.*brain\.fixture\.test/i,
  );
  await assert.rejects(
    runTechnicianStep({
      ...common,
      flags: {
        "confirm-environment": "production",
        "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
        "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
        "confirm-single-setup-machine": true,
      },
    }),
    /Production access.*confirm-production-access/i,
  );
  await assert.rejects(
    runTechnicianStep({
      ...common,
      isTTY: true,
      flags: {
        "confirm-environment": "production",
        "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
        "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
        "confirm-production-access": true,
      },
    }),
    /no remote cross-machine lock.*confirm-single-setup-machine/i,
  );
  assert.equal(hiddenReads, 0);
  assert.equal(setupCalls, 0);
});

test("Plaid local refusal runs before Cloudflare control or a hidden prompt", async () => {
  let cloudflareControls = 0;
  let hiddenReads = 0;
  await assert.rejects(
    cmdTechnician(manifestPath, {
      run: "plaid",
      "confirm-environment": "production",
      "confirm-redirect": "https://wrong.fixture.test/app/connect/bank",
      "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
      "confirm-production-access": true,
      "confirm-single-setup-machine": true,
    }, {
      isTTY: true,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      readHidden: async () => { hiddenReads++; return Buffer.from("must-not-be-read"); },
      withManifestControl: async () => { cloudflareControls++; },
    }),
    /confirm-redirect.*brain\.fixture\.test/i,
  );
  assert.equal(cloudflareControls, 0);
  assert.equal(hiddenReads, 0);
});

test("Plaid refuses Windows before Cloudflare control because hidden entry is not proven", async () => {
  let cloudflareControls = 0;
  let hiddenReads = 0;
  await assert.rejects(
    cmdTechnician(manifestPath, {
      run: "plaid",
      "confirm-environment": "production",
      "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
      "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
      "confirm-production-access": true,
      "confirm-single-setup-machine": true,
    }, {
      platformName: "win32",
      isTTY: true,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      readHidden: async () => { hiddenReads++; return Buffer.from("must-not-be-read"); },
      withManifestControl: async () => { cloudflareControls++; },
    }),
    /held on Windows.*cannot prove that PowerShell hid/is,
  );
  assert.equal(cloudflareControls, 0);
  assert.equal(hiddenReads, 0);
});

test("Plaid requires explicit native configuration and a direct owner terminal before hidden entry", async () => {
  let hiddenReads = 0;
  let setupCalls = 0;
  const writePlaidManifest = (name, bankFeed, domain = "brain.fixture.test") => {
    const path = join(sandbox, `${name}.json`);
    writeFileSync(path, JSON.stringify({ brain: { domain }, corpora: { bank_feed: bankFeed } }));
    return path;
  };
  const common = {
    step: "plaid",
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    readHidden: async () => { hiddenReads++; return Buffer.from("must-not-be-read"); },
    runPlaidSetup: async () => { setupCalls++; return {}; },
  };
  const cases = [
    ["implicit-provider", {
      enabled: true,
      environment: "sandbox",
      registered_redirect_uris: ["https://brain.fixture.test/app/connect/bank"],
      registered_webhook_uris: ["https://brain.fixture.test/api/webhooks/plaid"],
    }, /explicitly set to plaid/i],
    ["missing-environment", {
      enabled: true,
      provider: "plaid",
      registered_redirect_uris: ["https://brain.fixture.test/app/connect/bank"],
      registered_webhook_uris: ["https://brain.fixture.test/api/webhooks/plaid"],
    }, /must explicitly select sandbox or production/i],
    ["endpoint-override", {
      enabled: true,
      provider: "plaid",
      environment: "sandbox",
      api_base: "https://override.invalid",
      registered_redirect_uris: ["https://brain.fixture.test/app/connect/bank"],
      registered_webhook_uris: ["https://brain.fixture.test/api/webhooks/plaid"],
    }, /does not accept.*overrides/i],
    ["scheme-in-domain", {
      enabled: true,
      provider: "plaid",
      environment: "sandbox",
      registered_redirect_uris: ["https://brain.fixture.test/app/connect/bank"],
      registered_webhook_uris: ["https://brain.fixture.test/api/webhooks/plaid"],
    }, /final Brain address is still open/i, "https://brain.fixture.test"],
  ];
  for (const [name, feed, expected, domain] of cases) {
    await assert.rejects(
      runTechnicianStep({ ...common, manifestPath: writePlaidManifest(name, feed, domain), flags: {} }),
      expected,
    );
  }

  const sandboxManifest = writePlaidManifest("direct-terminal", {
    enabled: true,
    provider: "plaid",
    environment: "sandbox",
    registered_redirect_uris: ["https://brain.fixture.test/app/connect/bank"],
    registered_webhook_uris: ["https://brain.fixture.test/api/webhooks/plaid"],
  });
  await assert.rejects(
    runTechnicianStep({
      ...common,
      manifestPath: sandboxManifest,
      isTTY: false,
      flags: {
        "confirm-environment": "sandbox",
        "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
        "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
        "confirm-single-setup-machine": true,
      },
    }),
    /direct interactive terminal controlled by the owner/i,
  );
  await assert.rejects(
    runTechnicianStep({
      ...common,
      manifestPath: sandboxManifest,
      isTTY: true,
      flags: {
        port: "443",
        "confirm-environment": "sandbox",
        "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
        "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
      },
    }),
    /does not use --port/i,
  );
  await assert.rejects(
    runTechnicianStep({
      ...common,
      manifestPath: sandboxManifest,
      isTTY: true,
      flags: {
        "confirm-environment": "sandbox",
        "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
        "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
        "confirm-production-access": true,
        "confirm-single-setup-machine": true,
      },
    }),
    /applies only to the Production environment/i,
  );
  assert.equal(hiddenReads, 0);
  assert.equal(setupCalls, 0);
});

test("Plaid explains the ceremony, accepts values only through hidden prompts, and opens no child or bank flow", async () => {
  const clientId = Buffer.from("fixture-plaid-client-id");
  const clientSecret = Buffer.from("fixture-plaid-secret");
  const entered = [clientId, clientSecret];
  const announcements = [];
  let setupInput = null;
  let childCalls = 0;
  const receipt = await runTechnicianStep({
    step: "plaid",
    manifestPath,
    isTTY: true,
    flags: {
      "confirm-environment": "production",
      "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
      "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
      "confirm-production-access": true,
      "confirm-single-setup-machine": true,
    },
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: {
      PATH: "/safe/bin",
      BANK_FEED_CLIENT_ID: "ambient-client-id",
      BANK_FEED_SECRET: "ambient-secret",
      BANK_FEED_WRAPPING_KEY_V2: "ambient-wrapping-key",
    },
    announce: (message) => announcements.push(message),
    readHidden: async () => entered.shift(),
    spawn: () => { childCalls++; return { status: 0 }; },
    runPlaidSetup: async (input) => {
      assert.equal(input.clientId.toString(), "fixture-plaid-client-id");
      assert.equal(input.clientSecret.toString(), "fixture-plaid-secret");
      setupInput = {
        manifestPath: input.manifestPath,
        environment: input.environment,
        redirectUri: input.redirectUri,
        webhookUri: input.webhookUri,
      };
      return {
        applied_atomically: true,
        secret_names_verified: [
          "BANK_FEED_CLIENT_ID", "BANK_FEED_SECRET", "BANK_FEED_WRAPPING_KEY_V2",
        ],
        opened_bank_connection: false,
      };
    },
  });
  assert.deepEqual(setupInput, {
    manifestPath,
    environment: "production",
    redirectUri: "https://brain.fixture.test/app/connect/bank",
    webhookUri: "https://brain.fixture.test/api/webhooks/plaid",
  });
  assert.equal(childCalls, 0);
  assert.equal(receipt.proof_level, "worker_secret_name_readback");
  assert.equal(receipt.coordination_boundary, "single_supervised_owner_machine");
  assert.equal(receipt.remote_first_setup_compare_and_swap, false);
  assert.deepEqual(receipt.next, ["enroll_owner_passkey", "brain_connect_bank"]);
  assert.match(announcements.join("\n"), /changes only three Worker secrets/i);
  assert.match(announcements.join("\n"), /not placed in the command, shell history, plan, or support note/i);
  assert.doesNotMatch(announcements.join("\n"), /fixture-plaid/);
  assert.ok(clientId.every((byte) => byte === 0));
  assert.ok(clientSecret.every((byte) => byte === 0));
});

test("Plaid wipes the first hidden value when the second prompt is interrupted", async () => {
  const clientId = Buffer.from("fixture-plaid-client-id");
  let reads = 0;
  let setupCalls = 0;
  await assert.rejects(
    runTechnicianStep({
      step: "plaid",
      manifestPath,
      isTTY: true,
      flags: {
        "confirm-environment": "production",
        "confirm-redirect": "https://brain.fixture.test/app/connect/bank",
        "confirm-webhook": "https://brain.fixture.test/api/webhooks/plaid",
        "confirm-production-access": true,
        "confirm-single-setup-machine": true,
      },
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      readHidden: async () => {
        reads++;
        if (reads === 1) return clientId;
        throw new Error("owner cancelled the second hidden prompt");
      },
      runPlaidSetup: async () => { setupCalls++; },
    }),
    /owner cancelled the second hidden prompt/,
  );
  assert.equal(reads, 2);
  assert.equal(setupCalls, 0);
  assert.ok(clientId.every((byte) => byte === 0));
});

test("passkey enrollment refuses before mutation unless the exact final hostname is confirmed", async () => {
  let calls = 0;
  const common = {
    step: "passkey",
    manifestPath,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    spawn: () => { calls++; return { status: 0 }; },
  };
  await assert.rejects(
    runTechnicianStep({ ...common, flags: { "confirm-host": "other.fixture.test" } }),
    /exactly matches brain\.fixture\.test/,
  );
  assert.equal(calls, 0);
  await runTechnicianStep({ ...common, flags: { "confirm-host": "BRAIN.FIXTURE.TEST" } });
  assert.equal(calls, 1);
});

test("verification is ordered and stops at the first failed proof", async () => {
  const commands = [];
  await assert.rejects(
    runTechnicianStep({
      step: "verify",
      manifestPath,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      spawn: (_node, args) => {
        commands.push(args[1]);
        return { status: args[1] === "health" ? 1 : 0 };
      },
    }),
    /paused before completion/,
  );
  assert.deepEqual(commands, ["doctor", "health"]);
});

// Codex reads the same skill format from ~/.codex/skills, so one reviewed file
// serves both assistants. Installing only Claude Code leaves the guide missing
// in whichever tool the owner actually opens, which looks like the product
// simply does not have one.
test("the technician skill installs for both Claude Code and Codex, idempotently", async () => {
  const { installTechnicianSkillEverywhere, technicianSkillPaths, AGENT_SKILL_ROOTS } =
    await import("../operations/claude-skill.mjs");
  const { mkdtempSync, existsSync, readFileSync, writeFileSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // realpathSync: /tmp is a symlink on macOS and the installer correctly
  // refuses to write a skill through one.
  const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-agents-")));

  assert.deepEqual([...AGENT_SKILL_ROOTS], [".claude", ".codex"]);
  const paths = technicianSkillPaths({ home });
  assert.equal(paths.length, 2);
  assert.ok(paths.some((p) => p.includes(join(".claude", "skills"))));
  assert.ok(paths.some((p) => p.includes(join(".codex", "skills"))));

  const first = installTechnicianSkillEverywhere({ home });
  assert.equal(first.length, 2);
  for (const r of first) assert.equal(r.status, "installed", `${r.root}: ${r.error || ""}`);
  for (const p of paths) assert.ok(existsSync(p), `${p} must exist`);
  assert.equal(
    readFileSync(paths[0], "utf8"),
    readFileSync(paths[1], "utf8"),
    "both assistants must get the identical reviewed file",
  );

  // Re-running verifies rather than rewriting.
  for (const r of installTechnicianSkillEverywhere({ home })) {
    assert.equal(r.status, "verified");
    assert.equal(r.changed, false);
  }

  // One assistant failing is reported, not thrown, so it cannot silently cost
  // the other. A regular file where a directory belongs is the realistic shape:
  // it is what a stray download or a half-finished install leaves behind.
  writeFileSync(join(home, ".blocked"), "not a directory");
  const mixed = installTechnicianSkillEverywhere({ home, agentRoots: [".claude", ".blocked"] });
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].status, "verified", "a later failure must not undo an earlier success");
  assert.equal(mixed[1].status, "failed");
  assert.ok(mixed[1].error, "a failure must carry its reason");
});
