import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cmdLocalTools, cmdTechnician } from "../brain.mjs";
import { WRANGLER_PACKAGE } from "../doctor.mjs";

import {
  TECHNICIAN_RUN_STEPS,
  renderTechnicianStepBriefing,
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
  },
}));

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

for (const platformName of ["darwin", "win32"]) test(`local tool readiness proves Claude sign-in, pinned Wrangler, and the interactive Claude doctor on ${platformName}`, async () => {
  const calls = [];
  const skillHome = join(sandbox, `local-tools-home-${platformName}`);
  const environment = platformName === "win32"
    ? {
        USERPROFILE: "C:\\Users\\fixture",
        LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
        PATH: "C:\\Users\\fixture\\.local\\bin",
        SystemRoot: "C:\\Windows",
      }
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
    statfsImpl: target => {
      if (platformName === "win32") assert.equal(target, environment.LOCALAPPDATA);
      return { bavail: 3n * 1024n * 1024n, bsize: 1024n };
    },
    getEffectiveUserId: () => 501,
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "powershell.exe") return { ok: true, out: "BRAIN_STANDARD_USER" };
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
  if (platformName === "win32") {
    assert.ok(calls.some((call) => call.command === "powershell.exe" && /WindowsPrincipal/.test(call.args.at(-1))));
  }
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
  assert.match(content, /ask for only one\s+small action or answer at a time/i);
  assert.match(content, /offer to handle the official-page\s+navigation and non-secret form fields/i);
  assert.match(content, /Hand control back before sign-in, 2FA, credential reveal or entry, OAuth\s+consent, billing approval, a passkey window/i);
  assert.match(content, /Node\.js 22 or newer/i);
  assert.match(content, /at least 2 GiB free.*LOCALAPPDATA/is);
  assert.match(content, /without `sudo`, root, or Run as\s+administrator/i);
  assert.match(content, /Workers & Pages > Plans/i);
  assert.match(content, /owner confirm.*exact account.*Paid/is);
  assert.match(content, /before any Cloudflare\s+resource is created/i);
  assert.match(content, /cannot see or store your passkey, Face ID, fingerprint/i);
  assert.match(content, /> or device PIN/i);
  const optimizeStart = content.indexOf("## Keep Optimize separate");
  const updateStart = content.indexOf("## Route an update request first");
  assert.ok(optimizeStart > 0 && updateStart > optimizeStart,
    "the installed skill must keep Optimize separate before routing other work");
  const optimizeRoute = content.slice(optimizeStart, updateStart);
  assert.match(optimizeRoute, /CLI, technician skill,\s+and MCP registration/i);
  assert.match(optimizeRoute, /audit itself remains read-only/i);
  assert.match(optimizeRoute, /one clearly previewed bundle/i);
  assert.match(optimizeRoute, /technician skill, Claude\s+MCP registration, and Codex MCP registration/i);
  assert.match(optimizeRoute, /ask once for approval of that bundle/i);
  assert.match(optimizeRoute, /Do not invent or guess a repair command/i);
  assert.match(optimizeRoute, /CLI installation or replacement on its own supported path and approval/i);
  assert.match(optimizeRoute, /must not run/i);
  assert.ok(optimizeRoute.includes(renderCliCommands("brain invite")));
  assert.ok(optimizeRoute.includes(renderCliCommands("brain devices")));
  const credentialBoundary = content.slice(content.indexOf("## Credential boundary"));
  assert.match(credentialBoundary, /Normal fresh Cloudflare setup uses the owner's official browser sign-in/i);
  assert.match(credentialBoundary, /Do not send a fresh owner to the\s+API Tokens page/i);
  assert.match(credentialBoundary, /recovery path/i);
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
  assert.match(content, /one small action or answer at a time/i);
  assert.match(content, /browser control is available.*official-page navigation and non-secret fields/i);
  assert.match(content, /Node 22\+.*2 GiB.*LOCALAPPDATA.*without sudo, root, or Run as administrator/i);
  assert.match(content, /Workers & Pages > Plans > Paid.*narrow named browser session cannot read billing status/i);
  assert.match(content, /Optimize may report a missing CLI, skill, or MCP registration/i);
  assert.match(content, /one clearly previewed and approved bundle.*skill, Claude MCP, and Codex MCP/is);
  assert.match(content, /Do not invent a command.*CLI replacement separate/is);
  assert.match(content, /does not run passkey enrollment or device review/i);
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
  assert.equal(plan.schema_version, 3);
  assert.equal(plan.proof_level, "workflow_only");
  assert.deepEqual(plan.steps.map((step) => step.id), TECHNICIAN_RUN_STEPS);
  assert.equal(plan.steps[0].state, "ready_to_start");
  assert.equal(plan.steps[1].state, "ready_after_local_tools");
  assert.match(plan.warning, /Live proof arrives/i);
  assert.equal(plan.interaction.one_action_at_a_time, true);
  assert.match(plan.interaction.browser_assistance, /non-secret form fields/i);
  assert.match(plan.interaction.owner_handoff, /sign-in, 2FA, credential reveal or entry/i);
  assert.deepEqual(plan.prerequisites.map((item) => item.id), [
    "node", "install_drive", "install_session", "cloudflare_account", "workers_paid",
  ]);
  assert.match(JSON.stringify(plan.prerequisites), /LOCALAPPDATA/i);
  assert.match(JSON.stringify(plan.prerequisites), /narrow session cannot read billing status/i);
  assert.ok(plan.steps.every((step) => step.owner_guidance?.before_action && step.owner_guidance?.privacy));
  assert.match(JSON.stringify(plan), /hidden terminal prompts/i);
  assert.doesNotMatch(JSON.stringify(plan), /client_secret|app_password|api_token/i);
});

test("the normal Cloudflare briefing uses owner browser sign-in and cannot assign token homework", () => {
  const plan = technicianPlan(join(sandbox, "not-created.json"));
  const cloudflare = plan.steps.find((step) => step.id === "cloudflare");
  const text = renderTechnicianStepBriefing(cloudflare);
  assert.equal(cloudflare.dashboard_url, "https://dash.cloudflare.com/");
  assert.match(text, /official sign-in page/i);
  assert.match(text, /owner signs in, completes 2FA, selects the exact account, confirms Plans says Paid/i);
  assert.match(text, /Workers & Pages > Plans > Paid/i);
  assert.match(text, /narrow sign-in does not verify billing/i);
  assert.match(text, /Normal fresh setup creates, reveals, and copies no API token/i);
  assert.doesNotMatch(text, /create (?:an?|the).*token|reveal(?:ed)? token|API Tokens page/i);
});

test("the passkey briefing explains the next secure window before enrollment", () => {
  const text = renderTechnicianStepBriefing("passkey");
  assert.match(text, /Choosing Create my owner passkey then opens the device's secure passkey window/i);
  assert.match(text, /confirms that this is the owner and protects the private owner area/i);
  assert.match(text, /Face ID, fingerprint, device PIN, or screen lock/i);
  assert.match(text, /cannot see or store the owner's passkey, Face ID, fingerprint, or device PIN/i);
  assert.match(text, /Cancel if the hostname or prompt is unexpected/i);
});

test("the CLI prints a provider briefing before the selected child command starts", async () => {
  const order = [];
  await cmdTechnician(join(sandbox, "not-created.json"), { run: "tools" }, {
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin" },
    writeBriefing: (text) => order.push({ kind: "briefing", text }),
    spawn: () => { order.push({ kind: "child" }); return { status: 0 }; },
  });
  assert.deepEqual(order.map((event) => event.kind), ["briefing", "child"]);
  assert.match(order[0].text, /Before we start: Check this computer and install the owner tools/i);
});

test("the direct invite path renders the passkey explanation before minting a link", () => {
  const source = readFileSync(new URL("../brain.mjs", import.meta.url), "utf8");
  const inviteStart = source.indexOf("async function cmdInvite");
  const briefing = source.indexOf('console.log(renderTechnicianStepBriefing("passkey"))', inviteStart);
  const inviteWrite = source.indexOf('/api/admin/auth/invite', inviteStart);
  assert.ok(inviteStart > 0 && briefing > inviteStart && inviteWrite > briefing);
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
