/**
 * A small coordinator for the install-day account ceremonies.
 *
 * It deliberately does not become another credential store. Dashboard values
 * are read with the installer's existing hidden-input primitive, passed to one
 * short-lived child command through an allowlisted environment, then the input
 * buffers are zeroed. Nothing secret is placed in argv, a receipt, or JSON.
 *
 * The default command is read-only and machine-readable. This lets a human
 * technician, Codex, or another local assistant guide the same reviewed steps
 * without teaching an agent how to hold credentials.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { renderCopyableCommand } from "./command-display.mjs";

export const TECHNICIAN_STEPS = Object.freeze([
  Object.freeze({
    id: "tools",
    title: "Prepare and verify Claude Code, the Brain CLI, and Wrangler",
    dashboard_url: "https://financialbrain.ai/install",
    human_boundary: "Before approval, explain that the local tools step writes the reviewed technician skill for Claude Code, and for Codex only when Codex is already present, records local bootstrap status, and may add the Brain CLI folder to PATH. The owner signs in to Claude in their browser. The technician runs Anthropic's interactive doctor with Claude Code's normal approval prompts enabled.",
    automated_proof: "The installer verifies the Claude CLI version and sign-in, installs and reads back the personal /financial-brain-technician skill in each installed AI client, records bootstrap status, checks PATH, runs claude doctor in a real terminal, and runs the pinned Wrangler 4 CLI with a credential-scrubbed environment.",
  }),
  Object.freeze({
    id: "cloudflare",
    title: "Sign in to Cloudflare and install the private Brain",
    dashboard_url: "https://dash.cloudflare.com/",
    human_boundary: "Fresh setup uses browser sign-in and needs no API token. Claude Code may handle ordinary navigation, then the owner takes over for sign-in, 2FA, account confirmation, and final approval. Before approval, explain that normal setup also adds or updates the Brain MCP entry in installed AI tools and may create a new owner-workspace CLAUDE.md. Use --no-connect if the owner declines those local config writes. A token is recovery-only.",
    automated_proof: "The installer verifies the selected browser session, provisions the exact account, deploys, migrates, runs health checks, and either verifies the approved AI-tool wiring or records that --no-connect left it unchanged.",
  }),
  Object.freeze({
    id: "smoke",
    title: "Load the non-private first-install smoke document",
    dashboard_url: null,
    human_boundary: "The owner approves one fixed, public, non-customer smoke document and its tiny Workers AI embedding cost. No local file, account credential, or customer content is read.",
    automated_proof: "The installer posts the fixed document through the deployed authenticated ingest boundary, requires its exact per-document receipt, records a ready manual source receipt, drains the vector work, and leaves the document in the owner's Brain as durable first-install evidence.",
  }),
  Object.freeze({
    id: "google",
    title: "Connect Google Drive, Gmail, and Calendar",
    dashboard_url: "https://console.cloud.google.com/apis/credentials",
    human_boundary: "The owner chooses or creates the Google project and approves the OAuth consent screen in their browser.",
    automated_proof: "The connector stores the refresh grant locally and dry-runs each requested Google source.",
  }),
  Object.freeze({
    id: "zoom",
    title: "Connect Zoom cloud transcripts",
    dashboard_url: "https://marketplace.zoom.us/develop/create",
    human_boundary: "A Zoom admin creates a Server-to-Server OAuth app, grants the recording scope, and later saves the verified webhook subscription.",
    automated_proof: "The connector probes the account and plan, writes Worker secrets, proves the live webhook challenge, and only then prints the URL to save.",
  }),
  Object.freeze({
    id: "imap",
    title: "Connect an IMAP mailbox",
    dashboard_url: null,
    human_boundary: "The mailbox owner creates an app password in their provider and enters it only into the hidden terminal prompt.",
    automated_proof: "The connector performs a real read before storing the app password locally.",
  }),
  Object.freeze({
    id: "passkey",
    title: "Enroll the owner passkey",
    dashboard_url: null,
    human_boundary: "The agent explains the passkey ceremony first. The owner runs the invite command in a directly controlled terminal, opens the private 15-minute link on their device, checks the final Brain hostname, chooses Create my owner passkey, and completes the device's own Face ID, Touch ID, fingerprint, security-key, or PIN prompt themselves.",
    automated_proof: "The live Brain records privacy-safe ceremony outcome and timing. A local rehearsal cannot prove the physical-device ceremony.",
  }),
  Object.freeze({
    id: "verify",
    title: "Run the handoff checks",
    dashboard_url: null,
    human_boundary: "The technician reviews each result and keeps unavailable connector or passkey checks clearly marked for follow-up.",
    automated_proof: "Doctor, health, source freshness, and enrolled-device checks run in order and stop on the first failure.",
  }),
]);

export const TECHNICIAN_RUN_STEPS = Object.freeze(TECHNICIAN_STEPS.map((step) => step.id));
export const DEFERRED_PUBLIC_CONNECTOR_STEPS = Object.freeze([
  "google", "zoom", "imap",
]);

function cliLocator(cli) {
  if (!cli?.command || !Array.isArray(cli.args)) return null;
  return Object.freeze({
    command: resolve(String(cli.command)),
    args: Object.freeze(cli.args.map((value) => resolve(String(value)))),
  });
}

function exactCommand(cli, args, platformName = process.platform) {
  if (!cli) return null;
  return renderCopyableCommand(cli.command, [...cli.args, ...args], { platformName });
}

// A child receives enough normal process context to launch a browser, find
// Node, and reach the user's OS credential store. Everything credential-like is
// excluded unless this coordinator adds that exact value for the selected step.
const SAFE_ENV_NAMES = Object.freeze([
  "PATH", "SHELL", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY", "XDG_CONFIG_HOME",
  "LOCALAPPDATA", "APPDATA", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT",
  "BRAIN_GOOGLE_TOKEN_STORE", "BRAIN_IMAP_CREDENTIAL_STORE",
]);

export function technicianChildEnvironment(base = {}, explicit = {}) {
  const result = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof base[name] === "string" && base[name] !== "") result[name] = base[name];
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (typeof value === "string" && value !== "") result[name] = value;
  }
  return result;
}

function readManifestSummary(manifestPath, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const read = deps.readFileSync || readFileSync;
  const absolute = resolve(manifestPath);
  if (!exists(absolute)) {
    return { path: absolute, exists: false, final_hostname: null, enabled_connectors: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(read(absolute, "utf8"));
  } catch (error) {
    throw new Error(`could not read the technician manifest: ${error.message}`);
  }
  const enabled = ["google_drive", "gmail", "calendar", "zoom", "imap"]
    .filter((name) => manifest?.corpora?.[name]?.enabled === true);
  return {
    path: absolute,
    exists: true,
    final_hostname: typeof manifest?.brain?.domain === "string" && manifest.brain.domain.trim()
      ? manifest.brain.domain.trim().toLowerCase()
      : null,
    enabled_connectors: enabled,
  };
}

export function technicianPlan(manifestPath, deps = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    throw new Error("usage: brain technician <manifest> [--json] [--run <step>]");
  }
  const manifest = readManifestSummary(manifestPath, deps);
  const cli = cliLocator(deps.cli);
  const refresh = cli
    ? Object.freeze({
        command: cli.command,
        args: Object.freeze([...cli.args, "technician", manifest.path, "--json"]),
        mutates_external_state: false,
      })
    : null;
  return {
    schema_version: 4,
    mode: "read_only_plan",
    proof_level: "workflow_only",
    manifest,
    cli,
    refresh,
    warning: "This plan prepares the workflow. Live proof arrives during the account, connector, webhook, mailbox, and physical passkey checks.",
    assistance: {
      primary_surface: "claude_code",
      opening: "I can handle the technical navigation and forms while you stay in control of your accounts. I will pause only for private approvals and explain each one first.",
      modes: ["browser_help", "one_action_at_a_time"],
      browser_help: {
        use_when_available: true,
        agent_handles: [
          "ordinary navigation",
          "non-secret form fields",
          "reviewed permission scopes",
          "one-account restrictions",
          "short expirations",
          "exact redirect and webhook addresses",
        ],
        owner_handles: [
          "sign-in",
          "2FA and CAPTCHA",
          "billing acceptance",
          "final consent",
          "secret reveal and entry",
          "passkey and operating-system prompts",
        ],
        resume_only_after_secret_is_hidden: true,
        fresh_cloudflare_access: "browser sign-in; no API token",
        recovery_cloudflare_access: "Claude fills reviewed non-secret token settings and stops before Create Token; the owner creates, moves, and dismisses the secret privately",
      },
      local_configuration: {
        tools_writes: [
          "reviewed technician skill for Claude Code, plus Codex only when already present",
          "local bootstrap status",
          "Brain CLI PATH entry when needed",
        ],
        setup_writes: [
          "Brain MCP entry for installed AI tools unless --no-connect is chosen",
          "new owner-workspace CLAUDE.md when no file already exists",
        ],
        mcp_opt_out: "run setup with --no-connect, then preview brain mcp-config before separately approving --apply",
        literal_brain_credential_written_to_ai_config: false,
      },
    },
    coverage: {
      guided_steps: TECHNICIAN_RUN_STEPS.filter((step) => !DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step)),
      not_guided_in_this_release: [
        "Plaid connector ceremony",
        "Google connector ceremony",
        "QuickBooks connector ceremony",
        "Zoom connector ceremony",
        "IMAP connector ceremony",
        "Slack connector ceremony",
        "Notion connector ceremony",
        "Microsoft 365 connector ceremony",
        "Dropbox connector ceremony",
        "HubSpot connector ceremony",
        "watched-folder scheduling ceremony",
      ],
      note: "These sources may have separate connector commands or backlog work, but this technician plan does not claim to guide or prove them.",
    },
    rules: [
      "Run one step at a time and rerun the same step after an interruption.",
      "In Claude Code, offer browser help once. When accepted and available, handle ordinary navigation and non-secret forms instead of assigning dashboard homework to the owner.",
      "Keep tokens, client secrets, app passwords, invite codes, and authentication codes in provider pages or hidden terminal prompts.",
      "Stop browser observation before any secret is revealed and resume only after the owner says it is hidden again.",
      "Fresh Cloudflare setup uses browser sign-in without an API token. Treat token creation as recovery only.",
      "Before brain tools, disclose its technician-skill, bootstrap-status, and PATH writes and get approval.",
      "Before normal setup, disclose its MCP and possible new workspace-guide writes. Use --no-connect if the owner declines, then preview before any later --apply.",
      "The owner handles login, 2FA, consent, billing, and physical-device prompts.",
      "An agent explains the passkey ceremony but never runs or captures brain invite because its output contains the private one-time link.",
      "Enroll the first passkey only after the final Brain hostname is fixed.",
    ],
    steps: TECHNICIAN_STEPS.map((step, index) => {
      let state = "not_checked";
      if (step.id === "tools") state = "ready_to_start";
      if (step.id === "cloudflare" && !manifest.exists) state = "ready_after_local_tools";
      if (step.id === "cloudflare" && manifest.exists) state = "represented_by_install_record";
      if (["smoke", "google", "zoom", "imap", "passkey", "verify"].includes(step.id) && !manifest.exists) {
        state = "waiting_for_install_record";
      }
      if (step.id === "smoke" && manifest.exists) state = "ready_for_owner_approval";
      if (step.id === "zoom" && manifest.exists && !manifest.enabled_connectors.includes("zoom")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "google" && manifest.exists &&
          !["google_drive", "gmail", "calendar"].every((name) => manifest.enabled_connectors.includes(name))) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "imap" && manifest.exists && !manifest.enabled_connectors.includes("imap")) {
        state = "requires_manifest_enablement";
      }
      if (step.id === "passkey" && manifest.exists && !manifest.final_hostname) {
        state = "waiting_for_final_hostname";
      }
      if (DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id)) {
        state = "deferred_from_public_first_install";
      }
      const ownerOnly = step.id === "passkey";
      const agentAfterOwnerApproval = step.id === "cloudflare" && !manifest.exists;
      const ownerCli = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
      const ownerArgs = ["invite", manifest.path];
      const approvedAgentArgs = [
        "technician", manifest.path, "--run", "cloudflare",
        "--browser-sign-in",
        "--name", "<person-or-company>",
        "--slug", "<short-name>",
        "--cloudflare-account", "<create-or-existing>",
        "--cloudflare-account-id", "<32-character-account-id>",
        "--workers-paid-confirmed",
      ];
      return {
        order: index + 1,
        ...step,
        command: DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id) || ownerOnly || step.id === "cloudflare"
          ? null
          : technicianDisplayCommand(step.id, manifest.path, cli),
        state,
        ...(ownerOnly
          ? {
              owner_only_command: Object.freeze({
                command: ownerCli.command,
                args: Object.freeze([...ownerCli.args, ...ownerArgs]),
                execution_boundary: "owner_direct_terminal",
                mutates_external_state: true,
                must_run_in_direct_owner_terminal: true,
                reveals_one_time_link: step.id === "passkey",
                ...(step.id === "passkey"
                  ? {
                      agent_must_not_execute: true,
                      requires_pre_ceremony_explanation: true,
                      browser_prompt_requires_owner_click: true,
                    }
                  : {}),
              }),
              owner_only_display: exactCommand(ownerCli, ownerArgs),
            }
          : {}),
        ...(agentAfterOwnerApproval
          ? {
              agent_after_owner_approval: Object.freeze({
                command: ownerCli.command,
                args: Object.freeze([...ownerCli.args, ...approvedAgentArgs]),
                execution_boundary: "claude_after_explicit_owner_approval",
                mutates_external_state: true,
                requires_owner_approval: true,
                reviewed_non_secret_context: Object.freeze([
                  "person or company name",
                  "short Brain name",
                  "new or existing Cloudflare account",
                  "exact Cloudflare account id",
                  "Workers Paid is active on that account",
                ]),
                owner_keeps_control_of: Object.freeze([
                  "sign-in",
                  "2FA and CAPTCHA",
                  "billing acceptance",
                  "final consent",
                ]),
                accepts_cloudflare_token: false,
              }),
              agent_after_owner_approval_display: exactCommand(ownerCli, approvedAgentArgs),
            }
          : {}),
        ...(step.id === "cloudflare" && manifest.exists
          ? {
              represented_by_install_record: true,
              existing_install_guidance: "This Brain already has an install record. Do not run fresh setup. Check local tools and MCP on this computer, then use doctor and the live update guidance.",
            }
          : {}),
      };
    }),
  };
}

export function technicianDisplayCommand(step, manifestPath, cli = null, platformName = process.platform) {
  const path = resolve(manifestPath);
  const locator = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
  if (step === "google") return exactCommand(locator, ["technician", path, "--run", "google"], platformName);
  if (step === "imap") return exactCommand(locator, ["technician", path, "--run", "imap", "--host", "<imap-host>", "--user", "<email-address>"], platformName);
  if (step === "passkey") return exactCommand(locator, ["technician", path, "--run", "passkey", "--confirm-host", "<final-hostname>"], platformName);
  return exactCommand(locator, ["technician", path, "--run", step], platformName);
}

export function renderTechnicianPlan(plan) {
  const lines = [
    "",
    "Financial Brain technician setup",
    "================================",
    `Manifest: ${plan.manifest.path}`,
    `Install record: ${plan.manifest.exists ? "present, live state not checked" : "not created yet"}`,
    `Final hostname: ${plan.manifest.final_hostname || "not fixed yet"}`,
    "",
    "This screen prepares the visit. Each live check will add its own proof.",
    "Claude Code can handle ordinary browser navigation and non-secret forms when the owner chooses browser help.",
    "The owner handles login, 2FA, consent, billing, and physical passkey prompts.",
    "Sensitive values stay in provider pages or hidden terminal prompts.",
    "Local configuration writes are named before approval. Setup can use --no-connect when the owner wants AI-tool files left unchanged.",
    "",
  ];
  for (const step of plan.steps) {
    lines.push(`${step.order}. ${step.title}`);
    if (step.state !== "not_checked") lines.push(`   State: ${step.state.replaceAll("_", " ")}`);
    lines.push(`   ${step.human_boundary}`);
    if (step.command) lines.push(`   Run: ${step.command}`);
    else if (step.agent_after_owner_approval) {
      lines.push(`   Claude runs after your approval: ${step.agent_after_owner_approval_display}`);
    }
    else if (step.represented_by_install_record) lines.push(`   ${step.existing_install_guidance}`);
    else if (step.owner_only_command) lines.push(`   Owner-only direct terminal: ${step.owner_only_display}`);
    else lines.push("   No public first-install command is available for this deferred connector ceremony.");
    if (step.dashboard_url) lines.push(`   Dashboard: ${step.dashboard_url}`);
    lines.push("");
  }
  return lines.join("\n");
}

function childCommands(step, manifestPath, flags, scriptPath) {
  const path = resolve(manifestPath);
  const command = (...args) => [scriptPath, ...args];
  switch (step) {
    // The technician step is stricter than a read-only bootstrap snapshot. It
    // must not report completion from an agent shell when Claude's interactive
    // installation doctor was never able to run.
    case "tools": return [command("tools", "--require-doctor")];
    case "cloudflare": {
      if (flags["browser-sign-in"] !== true) {
        throw new Error("the Cloudflare technician step requires the owner's approved --browser-sign-in ceremony");
      }
      const name = typeof flags.name === "string" ? flags.name.trim() : "";
      if (!name || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error("the Cloudflare technician step needs the reviewed --name <person-or-company>");
      }
      const slug = typeof flags.slug === "string" ? flags.slug.trim().toLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
        throw new Error("the Cloudflare technician step needs a reviewed 2 to 41 character --slug");
      }
      const accountPath = typeof flags["cloudflare-account"] === "string"
        ? flags["cloudflare-account"].trim().toLowerCase()
        : "";
      if (!new Set(["create", "existing"]).has(accountPath)) {
        throw new Error("the Cloudflare technician step needs --cloudflare-account create or existing");
      }
      const accountId = typeof flags["cloudflare-account-id"] === "string"
        ? flags["cloudflare-account-id"].trim().toLowerCase()
        : "";
      if (!/^[a-f0-9]{32}$/.test(accountId)) {
        throw new Error("the Cloudflare technician step needs the exact reviewed 32-character --cloudflare-account-id");
      }
      if (flags["workers-paid-confirmed"] !== true) {
        throw new Error("the Cloudflare technician step needs the owner's --workers-paid-confirmed review");
      }
      if (flags["no-connect"] !== undefined && flags["no-connect"] !== true) {
        throw new Error("--no-connect is an approval switch and does not take a value");
      }
      return [command(
        "setup", path,
        "--browser-sign-in",
        "--name", name,
        "--slug", slug,
        "--cloudflare-account", accountPath,
        "--cloudflare-account-id", accountId,
        "--workers-paid-confirmed",
        ...(flags["no-connect"] === true ? ["--no-connect"] : []),
      )];
    }
    case "smoke": return [];
    case "google": return [command("connect", "google", "--scopes", String(flags.scopes || "drive,gmail,calendar"))];
    case "zoom": return [command("connect", "zoom", path)];
    case "imap": {
      const host = String(flags.host || "").trim();
      const user = String(flags.user || "").trim();
      if (!host || !user) throw new Error("the IMAP step needs --host <imap-host> and --user <email-address>");
      const args = ["connect", "imap", path, "--host", host, "--user", user];
      if (flags.port) args.push("--port", String(flags.port));
      if (flags.source) args.push("--source", String(flags.source));
      return [command(...args)];
    }
    case "passkey": return [command("invite", path)];
    case "verify": return [
      command("doctor", path),
      command("health", path),
      command("sources", path),
      command("devices", path),
    ];
    default: throw new Error(`--run accepts one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
  }
}

async function hiddenValue(readHidden, prompt, noun, { optional = false } = {}) {
  const entered = await readHidden({ prompt, noun, optional });
  const bytes = Buffer.isBuffer(entered) ? entered : Buffer.from(String(entered || ""), "utf8");
  if (!optional && bytes.length === 0) {
    bytes.fill(0);
    throw new Error(`${noun} cannot be empty`);
  }
  return bytes;
}

function bufferText(buffer) {
  return buffer.toString("utf8");
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runOne(spawn, nodePath, args, env) {
  const result = spawn(nodePath, args, { stdio: "inherit", env });
  if (result?.error) throw new Error(`the technician child could not start: ${result.error.message}`);
  if (result?.status !== 0) {
    throw new Error("this technician step paused before completion. The step is ready to try again after the item above is resolved.");
  }
}

export async function runTechnicianStep({
  step,
  manifestPath,
  flags = {},
  scriptPath,
  readHidden,
  baseEnv = process.env,
  spawn = spawnSync,
  nodePath = process.execPath,
  manifestDeps = {},
  runInstallSmoke = null,
  platformName = process.platform,
} = {}) {
  if (!TECHNICIAN_RUN_STEPS.includes(step)) {
    throw new Error(`--run accepts one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
  }
  if (!manifestPath || !scriptPath) throw new Error("the technician step needs a manifest and installer path");
  if (platformName === "win32" && ["google", "zoom", "imap"].includes(step)) {
    throw codedError(
      "this connector needs private credential entry that the current Windows release cannot safely provide from Claude Code. " +
        "The generic terminal prompt can echo secrets, so this step is unavailable on this computer. " +
        "Do not place the credential in a command or persistent environment variable.",
      "windows_secure_input_unavailable",
    );
  }
  const summary = readManifestSummary(manifestPath, manifestDeps);
  if (step === "cloudflare" && summary.exists) {
    throw new Error(
      "this Brain already has an install record, so the fresh Cloudflare setup ceremony is not available. " +
        "Check tools and MCP on this computer, then use doctor and the live update guidance."
    );
  }
  if (!["tools", "cloudflare"].includes(step) && !summary.exists) {
    throw new Error("the install record is not ready yet. The Cloudflare step creates it, and then this step can continue.");
  }
  if (step === "google") {
    const mapping = { drive: "google_drive", gmail: "gmail", calendar: "calendar" };
    const requested = String(flags.scopes || "drive,gmail,calendar").split(",").map((value) => value.trim()).filter(Boolean);
    const missing = requested.map((name) => mapping[name]).filter((name) => !name || !summary.enabled_connectors.includes(name));
    if (missing.length) {
      throw new Error(`the install plan needs these Google sources enabled before connection: ${requested.join(", ")}`);
    }
  }
  if (step === "passkey") {
    if (!summary.final_hostname) {
      throw new Error("the final Brain address is still open. Choose brain.domain first so the passkey is enrolled on its permanent address.");
    }
    const confirmed = String(flags["confirm-host"] || "").trim().toLowerCase();
    if (confirmed !== summary.final_hostname) {
      throw new Error(`passkey enrollment is ready after --confirm-host exactly matches ${summary.final_hostname}`);
    }
  }

  const secretBuffers = [];
  const explicitEnv = {};
  let childEnv = null;
  try {
    if (step === "google") {
      if (typeof readHidden !== "function") throw new Error("the Google step needs a secure interactive terminal");
      const clientId = await hiddenValue(readHidden, "  Google OAuth client ID (hidden): ", "Google OAuth client ID");
      const clientSecret = await hiddenValue(readHidden, "  Google OAuth client secret, if issued (hidden; Enter for none): ", "Google OAuth client secret", { optional: true });
      secretBuffers.push(clientId, clientSecret);
      explicitEnv.GOOGLE_CLIENT_ID = bufferText(clientId);
      if (clientSecret.length) explicitEnv.GOOGLE_CLIENT_SECRET = bufferText(clientSecret);
    }
    if (step === "zoom") {
      if (typeof readHidden !== "function") throw new Error("the Zoom step needs a secure interactive terminal");
      for (const [name, label] of [
        ["ZOOM_ACCOUNT_ID", "Zoom account ID"],
        ["ZOOM_CLIENT_ID", "Zoom client ID"],
        ["ZOOM_CLIENT_SECRET", "Zoom client secret"],
        ["ZOOM_WEBHOOK_SECRET_TOKEN", "Zoom webhook secret token"],
      ]) {
        const value = await hiddenValue(readHidden, `  ${label} (hidden): `, label);
        secretBuffers.push(value);
        explicitEnv[name] = bufferText(value);
      }
    }

    childEnv = technicianChildEnvironment(baseEnv, explicitEnv);
    const commands = childCommands(step, manifestPath, flags, resolve(scriptPath));
    for (const args of commands) runOne(spawn, nodePath, args, childEnv);
    if (step === "smoke") {
      if (typeof runInstallSmoke !== "function") {
        throw codedError(
          "the deployed first-install smoke runner is unavailable. No source proof was created.",
          "install_smoke_runner_unavailable",
        );
      }
      const proof = await runInstallSmoke({ manifestPath });
      return {
        step,
        completed: true,
        commands_run: 0,
        proof_level: "live_data_plane_postconditions",
        proof,
      };
    }
    return { step, completed: true, commands_run: commands.length };
  } finally {
    for (const buffer of secretBuffers) buffer.fill(0);
    for (const key of Object.keys(explicitEnv)) {
      explicitEnv[key] = "";
      if (childEnv) childEnv[key] = "";
    }
  }
}
