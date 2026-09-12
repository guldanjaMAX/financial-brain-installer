import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { cmdLocalTools, cmdTechnician } from "../brain.mjs";
import { WRANGLER_PACKAGE } from "../doctor.mjs";

import {
  TECHNICIAN_RUN_STEPS,
  renderTechnicianPlan,
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
  const optimizeRouteStart = content.indexOf("## Route an Optimize request first");
  const updateRouteStart = content.indexOf("## Route an update request first");
  const conciergeRouteStart = content.indexOf("## Offer Claude Code concierge browser help");
  const passkeyRouteStart = content.indexOf("## Explain every passkey ceremony before it starts");
  const setupRouteStart = content.indexOf("## Start here");
  const releaseManifest = content.indexOf("https://financialbrain.ai/update/manifest.json");
  const agentPlaybook = content.indexOf("https://financialbrain.ai/update/agent.md");
  const updateEntrypoint = content.indexOf(renderCliCommands("brain update [manifest]"));
  assert.ok(optimizeRouteStart > 0, "installed skill must route explicit Optimize requests");
  assert.ok(updateRouteStart > optimizeRouteStart,
    "owner-facing Optimize routing must run before general update or setup archaeology");
  assert.ok(conciergeRouteStart > updateRouteStart,
    "Claude Code browser assistance must follow update routing");
  assert.ok(passkeyRouteStart > conciergeRouteStart,
    "passkey context must follow browser assistance and precede the setup-oriented plan");
  assert.ok(setupRouteStart > passkeyRouteStart, "passkey routing must run before the setup-oriented plan");
  const optimizeRoute = content.slice(optimizeRouteStart, updateRouteStart);
  assert.match(optimizeRoute, /included\s+owner feature/i);
  const openingGoal = /What would you most\s+like your Financial Brain to help you understand or keep current\?/g;
  assert.equal([...optimizeRoute.matchAll(openingGoal)].length, 1,
    "Optimize must open with exactly one plain-language goal question");
  const openingGoalIndex = optimizeRoute.search(openingGoal);
  const mapReadDisclosureIndex = optimizeRoute.search(/This sends no Financial Map\s+snapshot and changes nothing\./);
  const financialPictureIndex = optimizeRoute.indexOf(renderCliCommands("brain financial-picture <manifest> --json"));
  assert.ok(openingGoalIndex >= 0 && mapReadDisclosureIndex > openingGoalIndex &&
    financialPictureIndex > mapReadDisclosureIndex,
  "Optimize must ask the goal, explain and read map state, then inventory the financial picture");
  assert.match(optimizeRoute, /I can check your Brain without changing\s+it/i);
  assert.match(optimizeRoute, /Do not narrate\s+skill selection, source-code inspection, PATH archaeology, release research/is);
  assert.match(optimizeRoute, /request already authorizes the contract's read-only checks/i);
  assert.match(optimizeRoute, /Do\s+not ask for a second approval/i);
  assert.match(optimizeRoute, /one brief progress update only if the checks take long/i);
  assert.match(optimizeRoute, /Optimize complete\. I made no changes to your\s+Brain, data, settings, access, or indexes/i);
  assert.match(optimizeRoute, /private local support note.*nothing was uploaded/is);
  assert.match(optimizeRoute, /checked this computer's Brain skill and MCP\s+connection but installed nothing/i);
  assert.match(optimizeRoute, /at most three short sections/i);
  assert.match(optimizeRoute, /Do not print the numbered fifteen-check table/i);
  assert.match(optimizeRoute, /duplicate-document count is an efficiency finding/i);
  assert.match(optimizeRoute, /missing connector receipt does not mean.*stored corpus is absent/is);
  assert.match(optimizeRoute,
    /failed or stale source as a scoped finding.*Continue the independent\s+read-only Optimize checks/is);
  assert.match(optimizeRoute,
    /Positive evidence\s+from available sources remains usable.*never treat the failed source as\s+proof that its stored corpus is absent or its history is complete/is);
  assert.match(optimizeRoute, /conclusion that depends on it as unproven/i);
  assert.match(optimizeRoute,
    /whole-Brain access failure may\s+prevent the remote checks.*must not prevent\s+independent local checks/is);
  assert.match(optimizeRoute,
    new RegExp(renderedCommand("brain financial-picture <manifest> --json"), "i"));
  assert.match(optimizeRoute, /records as an interview map/i);
  assert.match(optimizeRoute, /Never infer or auto-confirm ownership/i);
  assert.match(optimizeRoute, /owner's interview answer does not authorize a write/i);
  assert.match(optimizeRoute, /separate explicit owner\s+approval/i);
  assert.match(optimizeRoute, /Unzoned sources with no grants are sharing-readiness\s+work, not evidence that somebody currently has access/i);
  assert.match(optimizeRoute, /Leave passkeys\s+and enrolled devices out of Optimize/i);
  assert.match(optimizeRoute, /brain_financial_map.*mode: "read"/is);
  assert.match(optimizeRoute, /immediately before calling `brain_financial_map` with `mode: "read"`/i);
  assert.match(optimizeRoute, /assistant may still show an approval prompt.*authorizing a private read/is);
  assert.match(optimizeRoute, /possible mention until the owner confirms/i);
  assert.match(optimizeRoute,
    /before making any financial\s+completeness conclusion, offer the guided Owner Financial Map interview/is);
  assert.match(optimizeRoute, /guided Owner Financial Map interview.*one short adaptive question at a time/is);
  assert.match(optimizeRoute,
    /interview itself is\s+read-only.*conversational working draft.*does not submit a\s+preview/is);
  assert.match(optimizeRoute, /complete non-authoritative version 1 preview/is);
  assert.match(optimizeRoute,
    /end\s+Optimize without submitting the working draft.*separate explicit owner approval outside Optimize/is);
  assert.match(optimizeRoute, /MCP has no activation operation/i);
  assert.match(optimizeRoute, /Activation requires another separate owner decision.*outside Optimize/is);
  assert.match(optimizeRoute,
    new RegExp("Do not run `" + renderedCommand("brain devices") + "`", "i"));
  assert.match(optimizeRoute,
    new RegExp("Do not run `" + renderedCommand("brain tools") + "` during Optimize", "i"));
  assert.match(optimizeRoute,
    new RegExp("do not run `" + renderedCommand("brain mcp-config --apply") + "`", "i"));
  assert.match(optimizeRoute, /especially after a move to a new computer/i);
  assert.match(optimizeRoute, /Do not run a Golden evaluation, create a canned refusal exercise/i);
  assert.match(optimizeRoute, /Do not ask a\s+known-answer content question for MCP proof/i);
  assert.match(optimizeRoute, /protocol\s+initialization, connection status, and expected tool discovery/i);
  assert.match(optimizeRoute, /zoning\s+applies to the whole source/i);
  assert.match(optimizeRoute, /Only if the owner\s+explicitly approves that mapping/i);
  assert.match(optimizeRoute, /repeat its bounded projection pass/i);
  assert.match(optimizeRoute, /what improved, regressed, or stayed\s+unproven/i);
  assert.match(optimizeRoute, /estimate the affected scope, likely cost, expected answer impact/i);
  assert.match(optimizeRoute, /Prioritize findings by likely answer impact, not raw\s+count/i);
  assert.doesNotMatch(optimizeRoute, /planned owner-facing workflow|lucky|qualif(?:y|ies|ied) for access/i);
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
  const conciergeRoute = content.slice(conciergeRouteStart, passkeyRouteStart);
  assert.match(conciergeRoute, /Claude Code is the primary install surface/i);
  assert.match(conciergeRoute, /handle the technical navigation and forms/i);
  assert.match(conciergeRoute, /Fresh Cloudflare setup.*browser sign-in.*needs no API\s+token/is);
  assert.match(conciergeRoute, /Stop on the final review screen/i);
  assert.match(conciergeRoute, /owner checks the summary, chooses \*\*Create Token\*\*/i);
  assert.match(conciergeRoute, /Do not resume browser observation until.*secret is no longer visible/is);
  assert.match(conciergeRoute,
    new RegExp("`" + renderedCommand("brain tools") + "` installs or updates the reviewed technician skill", "i"));
  assert.match(conciergeRoute,
    new RegExp("Fresh `" + renderedCommand("brain setup") + "` normally\\s+adds or updates this Brain's MCP entry", "i"));
  assert.match(conciergeRoute, /run setup\s+with `--no-connect`/i);
  const passkeyRoute = content.slice(passkeyRouteStart, setupRouteStart);
  assert.match(passkeyRoute, /how the owner signs in.*private app/is);
  assert.match(passkeyRoute, /expires fifteen minutes.*works once/is);
  assert.match(passkeyRoute, /Nothing prompts merely because the page opened/i);
  assert.match(passkeyRoute, /Only the owner's click on \*\*Create my owner passkey\*\*/i);
  assert.match(passkeyRoute, /Face ID, Touch ID, a\s+fingerprint, a security key, or the device PIN/i);
  assert.match(passkeyRoute, /Biometric data never goes to Financial Brain/i);
  assert.match(passkeyRoute, /private passkey stays with\s+the device or the owner's chosen passkey provider/i);
  assert.match(passkeyRoute, /Are you ready to create the one-time owner\s+link in your own terminal\?/i);
  assert.match(passkeyRoute,
    new RegExp("Never execute or capture `" + renderedCommand("brain invite") + "` in the agent\\s+session", "i"));
  assert.match(passkeyRoute, /Do not click the web control/i);
  assert.match(passkeyRoute, /Canceling before a\s+passkey is successfully verified does not consume the link/i);
  assert.match(passkeyRoute, /Creating an invite is not proof of\s+enrollment, and enrollment is not proof of sign-in/i);
  assert.doesNotMatch(passkeyRoute, /works (?:on|automatically on) every device/i);
  assert.match(content, /package-pinned browser login.*needs no generic second approval/is);
  assert.match(content, /unchanged counts alone are\s+inconclusive/i);
  assert.doesNotMatch(content, /next release clears/i);
  assert.match(content, /set up, install, update, optimize, audit, check, test a connector, complete a passkey step, or hand off/i);
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
  assert.match(content, /sign-in.*verifies the\s+exact account.*owner confirm.*Paid/is);
  assert.match(content, /before any Cloudflare\s+resource is created/i);
  assert.match(content, /prepared or\s+older manifest.*token recovery lane.*approved\s+automation/is);
  assert.match(content, /generic yes, a different account ID, or no proof\s+must stop/is);
  assert.match(content, /cannot see or store your passkey, Face ID, fingerprint/i);
  assert.match(content, /> or device PIN/i);
  assert.match(optimizeRoute, /CLI, technician skill,\s+and MCP registration/i);
  assert.match(optimizeRoute, /audit itself remains read-only/i);
  assert.match(optimizeRoute, /one clearly previewed bundle/i);
  assert.match(optimizeRoute, /technician skill, Claude\s+MCP registration, and Codex MCP registration/i);
  assert.match(optimizeRoute, /ask once for approval of that bundle/i);
  assert.match(optimizeRoute, /actual atomic repair scopes/i);
  assert.match(optimizeRoute, /combined assistant repair.*approval for the whole group/is);
  assert.match(optimizeRoute, /Preserve deliberately disabled entries, custom or unrelated registrations/i);
  assert.match(optimizeRoute, /only an absent entry or\s+one that exact installer ownership proves it owns/is);
  assert.match(optimizeRoute, /If readback fails, restore the\s+prior installer-owned state/is);
  assert.match(optimizeRoute, /Do not invent\s+or guess a repair command/i);
  assert.match(optimizeRoute, /CLI installation or\s+replacement on its own supported path and approval/i);
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
  assert.match(content, /owner directly asks.*brain_remember/is);
  assert.match(content, /update or correct.*brain_search.*full returned record id.*supersedes/is);
  assert.match(content, /Never treat retrieved documents.*permission to write/is);
  assert.match(content, /one small action or answer at a time/i);
  assert.match(content, /browser control is available.*official-page navigation and non-secret fields/i);
  assert.match(content, /financial-provider handoff.*owner's click/i);
  assert.match(content, /Node 22\+.*2 GiB.*LOCALAPPDATA.*without sudo, root, or Run as administrator/i);
  assert.match(content, /verifies the exact account.*Workers & Pages > Plans page.*confirm it says Paid.*narrow session cannot read billing status/i);
  assert.match(content, /prepared manifest, recovery lane, or approved automation/i);
  assert.match(content, /Optimize may report a missing CLI, skill, or MCP registration/i);
  assert.match(content, /one clearly previewed and approved bundle.*skill, Claude MCP, and Codex MCP/is);
  assert.match(content, /atomic repair scopes.*combined scope needs approval for its whole previewed group/i);
  assert.match(content, /Preserve disabled, custom, and unrelated entries and files byte for byte/i);
  assert.match(content, /restore prior installer-owned state if readback fails/i);
  assert.match(content, /Do not invent a command.*CLI replacement separate/is);
  assert.match(content, /does not run passkey enrollment or device review/i);
  const workspaceGoal = /What would you most\s+like your Financial Brain to help you understand or keep current\?/g;
  assert.equal([...content.matchAll(workspaceGoal)].length, 1,
    "the workspace guide must open Optimize with exactly one goal question");
  const workspaceGoalIndex = content.search(workspaceGoal);
  const workspaceMapDisclosureIndex = content.search(/This sends no Financial Map\s+snapshot and changes nothing\./);
  assert.ok(workspaceMapDisclosureIndex > workspaceGoalIndex,
    "the workspace guide must explain the private map read after the goal question");
  assert.match(content, /brain_financial_map.*mode: "read".*approval prompt.*private read/is);
  assert.match(content,
    /Before any financial completeness conclusion, offer the guided read-only interview.*one short adaptive question/is);
  assert.match(content, /interview submits nothing.*End Optimize before previewing/is);
  assert.match(content, /separate explicit owner approval before preview mode/i);
  assert.match(content, /Activation requires another separate owner decision.*fresh passkey ceremony/is);
  assert.match(content, /MCP cannot activate it/i);
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
  const result = writeClaudeWorkspaceGuide(manifest, {
    brainCliPath: "/safe/bin/brain",
    existingOnly: true,
  });
  assert.equal(result.status, "preserved_unrelated_existing_file");
  assert.equal(readFileSync(target, "utf8"), "owner instructions\n");
});

test("update refreshes only an existing installer-managed Claude workspace guide", () => {
  const workspace = join(sandbox, "managed-claude-workspace-update");
  mkdirSync(workspace);
  const manifest = join(workspace, "brain.manifest.json");
  const target = join(workspace, "CLAUDE.md");
  writeFileSync(manifest, "{}");
  writeFileSync(target, `${CLAUDE_WORKSPACE_MARKER}\n# Older managed guide\n`, { mode: 0o600 });

  const refreshed = writeClaudeWorkspaceGuide(manifest, {
    brainCliPath: safeBrainPath,
    nodePath: safeNodePath,
    existingOnly: true,
  });
  const content = readFileSync(target, "utf8");
  assert.equal(refreshed.status, "written");
  assert.equal(refreshed.changed, true);
  assert.match(content, /owner directly asks.*brain_remember/is);
  assert.match(content, /update or correct.*brain_search.*full returned record id.*supersedes/is);
  assert.match(content, /normal approval/i);

  const missingWorkspace = join(sandbox, "missing-claude-workspace-update");
  mkdirSync(missingWorkspace);
  const missingManifest = join(missingWorkspace, "brain.manifest.json");
  const missingTarget = join(missingWorkspace, "CLAUDE.md");
  writeFileSync(missingManifest, "{}");
  const skipped = writeClaudeWorkspaceGuide(missingManifest, {
    brainCliPath: safeBrainPath,
    nodePath: safeNodePath,
    existingOnly: true,
  });
  assert.equal(skipped.status, "skipped_missing");
  assert.equal(existsSync(missingTarget), false);
});

test("the plan is read-only, ordered, honest about proof, and agent-readable", () => {
  const missing = join(sandbox, "not-created.json");
  const plan = technicianPlan(missing);
  assert.equal(plan.schema_version, 4);
  assert.equal(plan.mode, "read_only_plan");
  assert.equal(plan.proof_level, "workflow_only");
  assert.deepEqual(plan.steps.map((step) => step.id), TECHNICIAN_RUN_STEPS);
  assert.equal(plan.steps[0].state, "ready_to_start");
  assert.equal(plan.steps[0].dashboard_url, "https://financialbrain.ai/install");
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
  assert.match(plan.rules.join(" "), /fresh, resumed, recovery, and automation setup paths/i);
  assert.ok(plan.steps.every((step) => step.owner_guidance?.before_action && step.owner_guidance?.privacy));
  assert.match(JSON.stringify(plan), /hidden terminal prompts/i);
  assert.equal(plan.assistance.primary_surface, "claude_code");
  assert.deepEqual(plan.assistance.modes, ["browser_help", "one_action_at_a_time"]);
  assert.equal(plan.assistance.browser_help.use_when_available, true);
  assert.equal(plan.assistance.browser_help.resume_only_after_secret_is_hidden, true);
  assert.match(plan.assistance.browser_help.fresh_cloudflare_access, /no API token/i);
  assert.match(plan.assistance.local_configuration.tools_writes.join("\n"), /technician skill/i);
  assert.match(plan.assistance.local_configuration.setup_writes.join("\n"), /MCP entry/i);
  assert.match(plan.assistance.local_configuration.mcp_opt_out, /--no-connect.*preview.*--apply/i);
  assert.equal(plan.assistance.local_configuration.literal_brain_credential_written_to_ai_config, false);
  assert.equal(plan.coverage.bank_connections.state, "held_outside_ordinary_onboarding");
  assert.equal(plan.coverage.bank_connections.credentials_needed_here, false);
  assert.match(plan.coverage.bank_connections.owner_message, /You did nothing wrong/i);
  assert.match(plan.coverage.bank_connections.owner_message, /no bank password.*verification code.*Plaid setup key/i);
  assert.match(renderTechnicianPlan(plan), /Bank connections are not part of ordinary onboarding yet/i);
  assert.match(renderTechnicianPlan(plan), /live proof arrives/i);
  assert.match(plan.rules.join("\n"), /offer browser help once/i);
  assert.match(plan.rules.join("\n"), /token creation as recovery only/i);
  const cloudflare = plan.steps.find((step) => step.id === "cloudflare");
  assert.equal(cloudflare.owner_only_command, undefined);
  assert.equal(cloudflare.agent_after_owner_approval.execution_boundary, "claude_after_explicit_owner_approval");
  assert.equal(cloudflare.agent_after_owner_approval.requires_owner_approval, true);
  assert.equal(cloudflare.agent_after_owner_approval.mutates_external_state, true);
  assert.equal(cloudflare.agent_after_owner_approval.accepts_cloudflare_token, false);
  const cloudflareArgs = cloudflare.agent_after_owner_approval.args.join(" ");
  for (const flag of [
    "--browser-sign-in", "--name", "--slug", "--cloudflare-account",
    "--cloudflare-account-id", "--workers-paid-confirmed",
  ]) assert.match(cloudflareArgs, new RegExp(flag));
  assert.doesNotMatch(cloudflareArgs, /cloudflare-token/i);
  assert.match(renderTechnicianPlan(plan), /Claude runs after your approval/i);
  const passkey = plan.steps.find((step) => step.id === "passkey");
  assert.equal(passkey.owner_only_command.execution_boundary, "owner_direct_terminal");
  assert.equal(passkey.owner_only_command.reveals_one_time_link, true);
  assert.equal(passkey.owner_only_command.agent_must_not_execute, true);
  assert.equal(passkey.owner_only_command.requires_pre_ceremony_explanation, true);
  assert.equal(passkey.owner_only_command.browser_prompt_requires_owner_click, true);
  assert.match(plan.rules.join("\n"), /never runs or captures brain invite/i);
  assert.doesNotMatch(JSON.stringify(plan), /client_secret|app_password|api_token/i);
});

test("the retired Plaid technician entrypoint stops kindly before any access or mutation", async () => {
  let manifestTouched = false;
  let prompted = false;
  let spawned = false;
  let briefed = false;
  await assert.rejects(
    cmdTechnician("/must-not-be-read/brain.manifest.json", {
      run: "plaid",
      "confirm-environment": "production",
      "confirm-redirect": "https://must-not-open.invalid/app/connect/bank",
      "confirm-webhook": "https://must-not-open.invalid/api/webhooks/plaid",
      "confirm-production-access": true,
      "confirm-single-setup-machine": true,
    }, {
      manifestDeps: {
        existsSync: () => { manifestTouched = true; throw new Error("manifest touched"); },
        readFileSync: () => { manifestTouched = true; throw new Error("manifest touched"); },
      },
      readHidden: async () => { prompted = true; throw new Error("prompted"); },
      spawn: () => { spawned = true; throw new Error("spawned"); },
      writeBriefing: () => { briefed = true; },
    }),
    (error) => error.code === "SAFETY_REVIEW_REQUIRED" &&
      /Bank connections are not part of ordinary onboarding yet/i.test(error.message) &&
      /You did nothing wrong/i.test(error.message) &&
      /did not read the install record, request a credential, open a browser, contact a provider, or change anything/i.test(error.message) &&
      /separately reviewed owner-custody setup/i.test(error.message),
  );
  assert.equal(manifestTouched, false);
  assert.equal(prompted, false);
  assert.equal(spawned, false);
  assert.equal(briefed, false);
});

test("the normal Cloudflare briefing uses owner browser sign-in and cannot assign token homework", () => {
  const plan = technicianPlan(join(sandbox, "not-created.json"));
  const cloudflare = plan.steps.find((step) => step.id === "cloudflare");
  const text = renderTechnicianStepBriefing(cloudflare);
  assert.equal(cloudflare.dashboard_url, "https://dash.cloudflare.com/");
  assert.match(text, /official sign-in page/i);
  assert.match(text, /owner signs in, completes 2FA, selects the exact account.*approves consent.*confirms that account's plan page says Paid/i);
  assert.match(text, /Workers & Pages > Plans page.*confirms it says Paid/is);
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
  assert.deepEqual(call.args, [fixtureScriptPath, "tools", "--require-doctor"]);
  assert.equal(call.options.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("the Cloudflare technician step forwards the complete owner-reviewed browser ceremony", async () => {
  const freshManifest = join(sandbox, "fresh-cloudflare.json");
  const flags = {
    "browser-sign-in": true,
    name: "Example Owner Brain",
    slug: "example-owner-brain",
    "cloudflare-account": "existing",
    "cloudflare-account-id": "a".repeat(32),
    "workers-paid-confirmed": true,
  };
  let call;
  let paidAccountProof;
  const receipt = await runTechnicianStep({
    step: "cloudflare",
    manifestPath: freshManifest,
    flags,
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    baseEnv: { PATH: "/safe/bin", CLOUDFLARE_API_TOKEN: "must-not-cross" },
    spawn: (node, args, options) => {
      paidAccountProof = options.env.BRAIN_WORKERS_PAID_ACCOUNT_ID;
      call = { node, args, options };
      return { status: 0 };
    },
  });
  assert.deepEqual(receipt, { step: "cloudflare", completed: true, commands_run: 1 });
  assert.deepEqual(call.args, [
    fixtureScriptPath, "setup", resolve(freshManifest),
    "--browser-sign-in",
    "--name", "Example Owner Brain",
    "--slug", "example-owner-brain",
    "--cloudflare-account", "existing",
    "--cloudflare-account-id", "a".repeat(32),
    "--workers-paid-confirmed",
  ]);
  assert.equal(call.options.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(paidAccountProof, "a".repeat(32));
  assert.equal(call.options.env.BRAIN_WORKERS_PAID_ACCOUNT_ID, "");
});

test("the Cloudflare technician step refuses incomplete context before spawning", async () => {
  const complete = {
    "browser-sign-in": true,
    name: "Example Owner Brain",
    slug: "example-owner-brain",
    "cloudflare-account": "existing",
    "cloudflare-account-id": "a".repeat(32),
    "workers-paid-confirmed": true,
  };
  const invalid = [
    { ...complete, "browser-sign-in": false },
    { ...complete, name: "" },
    { ...complete, slug: "Unsafe Slug" },
    { ...complete, "cloudflare-account": "guess" },
    { ...complete, "cloudflare-account-id": "short" },
    { ...complete, "workers-paid-confirmed": false },
    { ...complete, "no-connect": "yes" },
  ];
  for (const flags of invalid) {
    let calls = 0;
    await assert.rejects(runTechnicianStep({
      step: "cloudflare",
      manifestPath: join(sandbox, "fresh-cloudflare-invalid.json"),
      flags,
      scriptPath: fixtureScriptPath,
      nodePath: fixtureNodePath,
      spawn: () => { calls++; return { status: 0 }; },
    }));
    assert.equal(calls, 0);
  }
});

test("the Cloudflare technician step forwards an approved no-connect switch", async () => {
  let call;
  await runTechnicianStep({
    step: "cloudflare",
    manifestPath: join(sandbox, "fresh-cloudflare-no-connect.json"),
    flags: {
      "browser-sign-in": true,
      name: "Example Owner Brain",
      slug: "example-owner-brain",
      "cloudflare-account": "create",
      "cloudflare-account-id": "b".repeat(32),
      "workers-paid-confirmed": true,
      "no-connect": true,
    },
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    spawn: (_node, args) => { call = args; return { status: 0 }; },
  });
  assert.deepEqual(call.slice(-2), ["--workers-paid-confirmed", "--no-connect"]);
});

test("an existing install record never advertises or launches fresh Cloudflare setup", async () => {
  const plan = technicianPlan(manifestPath);
  const cloudflare = plan.steps.find((step) => step.id === "cloudflare");
  assert.equal(cloudflare.state, "represented_by_install_record");
  assert.equal(cloudflare.command, null);
  assert.equal(cloudflare.agent_after_owner_approval, undefined);
  assert.equal(cloudflare.owner_only_command, undefined);
  assert.match(cloudflare.existing_install_guidance, /tools and MCP.*doctor.*update/i);
  assert.doesNotMatch(renderTechnicianPlan(plan), /--browser-sign-in/i);

  let calls = 0;
  await assert.rejects(runTechnicianStep({
    step: "cloudflare",
    manifestPath,
    flags: {
      "browser-sign-in": true,
      name: "Example Owner Brain",
      slug: "example-owner-brain",
      "cloudflare-account": "existing",
      "cloudflare-account-id": "a".repeat(32),
      "workers-paid-confirmed": true,
    },
    scriptPath: fixtureScriptPath,
    nodePath: fixtureNodePath,
    spawn: () => { calls++; return { status: 0 }; },
  }), /already has an install record/i);
  assert.equal(calls, 0);
});

test("the technician tools contract cannot complete without the interactive Claude doctor", async () => {
  await assert.rejects(
    cmdLocalTools({
      isTTY: false,
      requireDoctor: true,
      platformName: "darwin",
      environment: { HOME: join(sandbox, "strict-tools-home"), PATH: "/usr/bin:/bin" },
      getEffectiveUserId: () => 501,
      runCommand: (command, args) => {
        if (command === "npx") return { ok: true, out: "wrangler 4.127.1" };
        if (args[0] === "--version") return { ok: true, out: "2.1.63 (Claude Code)" };
        if (args.join(" ") === "auth status") return { ok: true, out: "signed in" };
        return { ok: false, out: "unexpected fixture command" };
      },
      installClaudeSkill: () => ({ status: "verified", path: "/safe/skill" }),
      persistCliPath: () => ({ action: "skipped", reason: "fixture" }),
    }),
    /not complete.*interactive terminal/is,
  );
});

test("Windows connector steps stop before every secret prompt and child launch", async () => {
  for (const step of ["google", "zoom", "imap"]) {
    let promptCalls = 0;
    let childCalls = 0;
    await assert.rejects(
      runTechnicianStep({
        step,
        manifestPath,
        scriptPath: fixtureScriptPath,
        nodePath: fixtureNodePath,
        platformName: "win32",
        readHidden: async () => {
          promptCalls++;
          return Buffer.from("must-not-be-read");
        },
        spawn: () => {
          childCalls++;
          return { status: 0 };
        },
      }),
      (error) => error.code === "windows_secure_input_unavailable" &&
        /does not include a verified Windows secret-entry bridge/i.test(error.message) &&
        /stops before asking.*launching the connector/i.test(error.message) &&
        /persistent environment variable/i.test(error.message),
    );
    assert.equal(promptCalls, 0, `${step} must not ask for a secret on Windows`);
    assert.equal(childCalls, 0, `${step} must not launch its connector on Windows`);
  }
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
  const paidAccountId = "d".repeat(32);
  const env = technicianChildEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex-home",
    LANG: "en_US.UTF-8",
    BRAIN_WORKERS_PAID_ACCOUNT_ID: paidAccountId,
    CLOUDFLARE_API_TOKEN: "must-not-cross",
    OPENAI_API_KEY: "must-not-cross",
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    GOOGLE_CLIENT_SECRET: "must-not-cross",
    ZOOM_CLIENT_SECRET: "must-not-cross",
    RANDOM_APPLICATION_VALUE: "must-not-cross",
  });
  assert.deepEqual(env, {
    PATH: "/safe/bin",
    HOME: "/safe/home",
    CODEX_HOME: "/safe/codex-home",
    LANG: "en_US.UTF-8",
    BRAIN_WORKERS_PAID_ACCOUNT_ID: paidAccountId,
  });
  assert.doesNotMatch(JSON.stringify(env), /must-not-cross/);
  assert.deepEqual(
    technicianChildEnvironment({ BRAIN_WORKERS_PAID_ACCOUNT_ID: "must-not-cross" }),
    {},
    "the non-secret approval channel accepts only an account id",
  );
});

test("Google credentials cross only the child environment, never argv, and input buffers are zeroed", async () => {
  const clientId = Buffer.from("fixture-google-client-id");
  const clientSecret = Buffer.from("fixture-google-client-secret");
  const entered = [clientId, clientSecret];
  const calls = [];
  const receipt = await runTechnicianStep({
    step: "google",
    platformName: "darwin",
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
    platformName: "darwin",
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
    platformName: "darwin",
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

test("passkey enrollment rejects every non-hostname brain.domain before mutation", async () => {
  const invalidDomains = [
    "https://brain.fixture.test",
    "brain.fixture.test/path",
    "brain.fixture.test?mode=owner",
    "brain.fixture.test#owner",
    "owner@brain.fixture.test",
    "brain.fixture.test:443",
    "127.0.0.1",
    "localhost",
    "bad_label.fixture.test",
    "-bad.fixture.test",
  ];
  let calls = 0;
  for (const domain of invalidDomains) {
    const manifestDeps = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ brain: { domain }, corpora: {} }),
    };
    const plan = technicianPlan("/fixture/invalid-domain.json", manifestDeps);
    assert.equal(plan.manifest.final_hostname, null, domain);
    assert.equal(plan.manifest.final_hostname_invalid, true, domain);
    assert.equal(plan.steps.find((step) => step.id === "passkey").state, "invalid_final_hostname", domain);
    await assert.rejects(
      runTechnicianStep({
        step: "passkey",
        manifestPath: "/fixture/invalid-domain.json",
        flags: { "confirm-host": domain },
        scriptPath: fixtureScriptPath,
        nodePath: fixtureNodePath,
        manifestDeps,
        spawn: () => { calls++; return { status: 0 }; },
      }),
      /one final hostname with no scheme, port, path, credentials, query, or fragment/i,
      domain,
    );
  }
  assert.equal(calls, 0);
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

test("the technician skill defaults to Claude and includes Codex only when already present", async () => {
  const { installTechnicianSkillEverywhere, technicianSkillPaths, AGENT_SKILL_ROOTS } =
    await import("../operations/claude-skill.mjs");
  const { mkdtempSync, existsSync, readFileSync, writeFileSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // realpathSync: /tmp is a symlink on macOS and the installer correctly
  // refuses to write a skill through one.
  const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "fb-agents-")));

  assert.deepEqual([...AGENT_SKILL_ROOTS], [".claude"]);
  const claudeOnly = installTechnicianSkillEverywhere({ home });
  assert.deepEqual(claudeOnly.map((result) => result.root), [".claude"]);
  assert.equal(existsSync(join(home, ".codex")), false, "Claude-only setup must not create a Codex config tree");

  mkdirSync(join(home, ".codex"));
  const paths = technicianSkillPaths({ home });
  assert.equal(paths.length, 2);
  assert.ok(paths.some((p) => p.includes(join(".claude", "skills"))));
  assert.ok(paths.some((p) => p.includes(join(".codex", "skills"))));

  const first = installTechnicianSkillEverywhere({ home });
  assert.equal(first.length, 2);
  assert.equal(first[0].status, "verified");
  assert.equal(first[1].status, "installed");
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
