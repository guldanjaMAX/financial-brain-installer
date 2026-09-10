/**
 * A small coordinator for the install-day account ceremonies.
 *
 * It deliberately does not become another credential store. Dashboard values
 * are read with the installer's existing hidden-input primitive. Existing
 * connector ceremonies use short-lived children with allowlisted environments;
 * Plaid stays inside its dedicated reviewed API boundary. Input buffers are
 * then zeroed. Nothing secret is placed in argv, a receipt, or JSON.
 *
 * The default command is read-only and machine-readable. This lets a human
 * technician, Codex, or another local assistant guide the same reviewed steps
 * without teaching an agent how to hold credentials.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { renderCopyableCommand } from "./command-display.mjs";
import { bankFeedRedirectUri, plaidWebhookUri } from "../doctor.mjs";

export const TECHNICIAN_STEPS = Object.freeze([
  Object.freeze({
    id: "tools",
    title: "Install and verify Claude Code, the Brain CLI, and Wrangler",
    dashboard_url: "https://financialbrain.ai/install",
    human_boundary: "The owner signs in to Claude in their browser. The technician runs Anthropic's interactive doctor with Claude Code's normal approval prompts enabled.",
    automated_proof: "The installer verifies the Claude CLI version and sign-in, installs and reads back the personal /financial-brain-technician skill, runs claude doctor in a real terminal, and runs the pinned Wrangler 4 CLI with a credential-scrubbed environment.",
  }),
  Object.freeze({
    id: "cloudflare",
    title: "Install the private Brain",
    dashboard_url: "https://dash.cloudflare.com/profile/api-tokens",
    human_boundary: "The owner signs in, completes 2FA, and creates the least-privilege token. The hidden terminal prompt is ready when it is time to enter the token.",
    automated_proof: "The installer verifies the token, provisions the exact account, deploys, migrates, and runs health checks.",
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
    id: "plaid",
    title: "Prepare the native Plaid connection",
    dashboard_url: "https://dashboard.plaid.com/team/api",
    human_boundary: "Inside an approved, version-scoped field plan, the owner confirms the selected Plaid environment and Production access when applicable, then verifies the exact redirect and webhook URLs in their own Plaid dashboard. The client ID and secret go only into hidden prompts.",
    automated_proof: "The installer generates or reuses an independent protected wrapping key, atomically applies only the three bank-feed Worker secrets, and reads back only those three binding names. It does not open Link or contact a bank.",
  }),
  Object.freeze({
    id: "passkey",
    title: "Enroll the owner passkey",
    dashboard_url: null,
    human_boundary: "The owner opens the 15-minute link on their device and completes Face ID, fingerprint, or device PIN on the final Brain hostname.",
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

export const PLAID_WINDOWS_SECRET_ENTRY_HOLD =
  "Plaid application-secret entry is held on Windows because this CLI cannot prove that PowerShell hid the typed values. " +
  "Do not enter them here or move them through environment variables. Use a reviewed non-Windows candidate or wait for a proven native masked Windows bridge.";

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
  const feed = manifest?.corpora?.bank_feed || {};
  const rawDomain = typeof manifest?.brain?.domain === "string"
    ? manifest.brain.domain.trim()
    : "";
  let finalHostname = null;
  try {
    const parsed = new URL(`https://${rawDomain}`);
    if (rawDomain && !rawDomain.includes("://") && parsed.protocol === "https:" &&
        !parsed.username && !parsed.password &&
        !parsed.port && parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      finalHostname = parsed.hostname.toLowerCase();
    }
  } catch { /* invalid or incomplete hostname remains visibly unsettled */ }
  const redirectUri = finalHostname ? bankFeedRedirectUri(finalHostname) : null;
  const webhookUri = finalHostname ? plaidWebhookUri(finalHostname) : null;
  return {
    path: absolute,
    exists: true,
    final_hostname: finalHostname,
    enabled_connectors: enabled,
    bank_feed: {
      enabled: feed.enabled === true,
      provider: typeof feed.provider === "string" ? feed.provider.trim().toLowerCase() : null,
      environment: typeof feed.environment === "string" ? feed.environment.trim().toLowerCase() : null,
      endpoint_override: ["api_base", "link_sdk_url", "link_global"].some((name) =>
        Object.hasOwn(feed, name)),
      redirect_uri: redirectUri,
      webhook_uri: webhookUri,
      redirect_recorded: Boolean(redirectUri &&
        Array.isArray(feed.registered_redirect_uris) &&
        feed.registered_redirect_uris.includes(redirectUri)),
      webhook_recorded: Boolean(webhookUri &&
        Array.isArray(feed.registered_webhook_uris) &&
        feed.registered_webhook_uris.includes(webhookUri)),
    },
  };
}

function assertPlaidTechnicianPreflight(summary, flags, isTTY, platformName) {
  const feed = summary.bank_feed;
  const allowed = new Set([
    "run", "confirm-environment", "confirm-redirect", "confirm-webhook",
    "confirm-production-access", "confirm-single-setup-machine",
  ]);
  const unexpected = Object.keys(flags).filter((name) => !allowed.has(name));
  if (unexpected.length) {
    throw new Error(`the Plaid step does not use --${unexpected[0]}`);
  }
  if (!feed.enabled) {
    throw new Error("the native bank feed must be explicitly enabled in the approved field-plan manifest before Plaid setup");
  }
  if (feed.provider !== "plaid") {
    throw new Error("the Plaid technician step requires corpora.bank_feed.provider to be explicitly set to plaid");
  }
  if (feed.endpoint_override) {
    throw new Error("the native Plaid profile does not accept api_base, link_sdk_url, or link_global overrides; remove them before entering credentials");
  }
  if (!["sandbox", "production"].includes(feed.environment)) {
    throw new Error("corpora.bank_feed.environment must explicitly select sandbox or production before Plaid setup");
  }
  if (!summary.final_hostname) {
    throw new Error("the final Brain address is still open. Deploy and settle brain.domain before registering Plaid URLs.");
  }
  if (!feed.redirect_recorded || !feed.webhook_recorded) {
    throw new Error(
      `record these exact URLs in the selected Plaid environment and in the manifest before entering credentials:\n` +
        `  redirect: ${feed.redirect_uri}\n` +
        `  webhook: ${feed.webhook_uri}`,
    );
  }
  const confirmedEnvironment = String(flags["confirm-environment"] || "").trim().toLowerCase();
  if (confirmedEnvironment !== feed.environment) {
    throw new Error(`--confirm-environment must exactly match the manifest's ${feed.environment} Plaid environment`);
  }
  if (String(flags["confirm-redirect"] || "").trim() !== feed.redirect_uri) {
    throw new Error(`--confirm-redirect must exactly match ${feed.redirect_uri}`);
  }
  if (String(flags["confirm-webhook"] || "").trim() !== feed.webhook_uri) {
    throw new Error(`--confirm-webhook must exactly match ${feed.webhook_uri}`);
  }
  if (feed.environment === "production" && flags["confirm-production-access"] !== true) {
    throw new Error(
      "Production credentials may be entered only after the owner verifies Plaid Dashboard shows Production access; rerun with --confirm-production-access after that check",
    );
  }
  if (flags["confirm-production-access"] !== undefined &&
      flags["confirm-production-access"] !== true) {
    throw new Error("--confirm-production-access is a switch and does not take a value");
  }
  if (feed.environment !== "production" && flags["confirm-production-access"] === true) {
    throw new Error("--confirm-production-access applies only to the Production environment; omit it for Sandbox");
  }
  if (flags["confirm-single-setup-machine"] !== true) {
    throw new Error(
      "Plaid first-time secret setup has no remote cross-machine lock. Run one supervised owner session on one nominated computer and confirm it with --confirm-single-setup-machine.",
    );
  }
  if (platformName === "win32") {
    throw new Error(PLAID_WINDOWS_SECRET_ENTRY_HOLD);
  }
  if (!isTTY) {
    throw new Error(
      "Plaid application values can be entered only in a direct interactive terminal controlled by the owner. Open that terminal and rerun the same command.",
    );
  }
}

/** Pure local Plaid refusal boundary. It must pass before Cloudflare sign-in starts. */
export function plaidTechnicianPreflight(manifestPath, {
  flags = {},
  manifestDeps = {},
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  platformName = process.platform,
} = {}) {
  const summary = readManifestSummary(manifestPath, manifestDeps);
  if (!summary.exists) {
    throw new Error("the install record is not ready yet. The Cloudflare step creates it, and then this step can continue.");
  }
  assertPlaidTechnicianPreflight(summary, flags, isTTY, platformName);
  return summary;
}

export function technicianPlan(manifestPath, deps = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    throw new Error("usage: brain technician <manifest> [--json] [--run <step>]");
  }
  const manifest = readManifestSummary(manifestPath, deps);
  const platformName = deps.platformName ?? process.platform;
  const cli = cliLocator(deps.cli);
  const refresh = cli
    ? Object.freeze({
        command: cli.command,
        args: Object.freeze([...cli.args, "technician", manifest.path, "--json"]),
        mutates_external_state: false,
      })
    : null;
  return {
    schema_version: 2,
    mode: "read_only_plan",
    proof_level: "workflow_only",
    manifest,
    cli,
    refresh,
    warning: "This plan prepares the workflow. The Plaid step is limited to an approved, version-scoped field plan while general bank invitations remain held. Live proof arrives during the account, connector, webhook, mailbox, and physical passkey checks.",
    coverage: {
      guided_steps: TECHNICIAN_RUN_STEPS.filter((step) => !DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step)),
      not_guided_in_this_release: [
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
      note: "Plaid application-secret setup is guided but remains held and field-unproven. The sources listed here may have separate connector commands or backlog work, but this technician plan does not claim to guide or prove them.",
    },
    rules: [
      "Run one step at a time and rerun the same step after an interruption.",
      "Keep tokens, client secrets, app passwords, invite codes, and authentication codes in provider pages or hidden terminal prompts.",
      "The owner handles login, 2FA, consent, billing, and physical-device prompts.",
      "Enroll the first passkey only after the final Brain hostname is fixed.",
      "Run the Plaid ceremony only inside a named, version-scoped disposable-candidate plan or a separately approved production pilot while general invitations remain held.",
    ],
    steps: TECHNICIAN_STEPS.map((step, index) => {
      let state = "not_checked";
      if (step.id === "tools") state = "ready_to_start";
      if (step.id === "cloudflare" && !manifest.exists) state = "ready_after_local_tools";
      if (["smoke", "google", "zoom", "imap", "plaid", "passkey", "verify"].includes(step.id) && !manifest.exists) {
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
      if (step.id === "plaid" && manifest.exists) {
        if (!manifest.bank_feed.enabled) state = "requires_manifest_enablement";
        else if (manifest.bank_feed.provider !== "plaid") state = "requires_native_plaid_provider";
        else if (manifest.bank_feed.endpoint_override) state = "requires_endpoint_cleanup";
        else if (!["sandbox", "production"].includes(manifest.bank_feed.environment)) {
          state = "requires_environment_selection";
        }
        else if (!manifest.final_hostname) state = "waiting_for_final_hostname";
        else if (!manifest.bank_feed.redirect_recorded || !manifest.bank_feed.webhook_recorded) {
          state = "requires_provider_dashboard_registration";
        } else state = "ready_for_owner_confirmation";
        if (platformName === "win32") state = "held_windows_masked_input_unproven";
      }
      if (step.id === "passkey" && manifest.exists && !manifest.final_hostname) {
        state = "waiting_for_final_hostname";
      }
      if (DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id)) {
        state = "deferred_from_public_first_install";
      }
      const ownerOnly = ["cloudflare", "plaid", "passkey"].includes(step.id);
      const ownerCli = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
      const ownerArgs = step.id === "passkey"
        ? ["invite", manifest.path]
        : step.id === "plaid"
          ? plaidTechnicianArgs(manifest.path, manifest.bank_feed)
          : ["technician", manifest.path, "--run", step.id];
      return {
        order: index + 1,
        ...step,
        command: DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id) || ownerOnly
          ? null
          : technicianDisplayCommand(step.id, manifest.path, cli, platformName, manifest.bank_feed),
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
              }),
              owner_only_display: exactCommand(ownerCli, ownerArgs),
            }
          : {}),
      };
    }),
  };
}

function plaidTechnicianArgs(manifestPath, bankFeed = {}) {
  const args = [
    "technician", manifestPath, "--run", "plaid",
    "--confirm-environment", bankFeed?.environment || "<sandbox-or-production>",
    "--confirm-redirect", bankFeed?.redirect_uri || "<exact-redirect-url>",
    "--confirm-webhook", bankFeed?.webhook_uri || "<exact-webhook-url>",
    "--confirm-single-setup-machine",
  ];
  if (bankFeed?.environment === "production") args.push("--confirm-production-access");
  return args;
}

export function technicianDisplayCommand(
  step,
  manifestPath,
  cli = null,
  platformName = process.platform,
  bankFeed = {},
) {
  const path = resolve(manifestPath);
  const locator = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
  if (step === "google") return exactCommand(locator, ["technician", path, "--run", "google"], platformName);
  if (step === "imap") return exactCommand(locator, ["technician", path, "--run", "imap", "--host", "<imap-host>", "--user", "<email-address>"], platformName);
  if (step === "passkey") return exactCommand(locator, ["technician", path, "--run", "passkey", "--confirm-host", "<final-hostname>"], platformName);
  if (step === "plaid") return exactCommand(locator, plaidTechnicianArgs(path, bankFeed), platformName);
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
    "The owner handles login, 2FA, consent, billing, and physical passkey prompts.",
    "Sensitive values stay in provider pages or hidden terminal prompts.",
    "",
  ];
  for (const step of plan.steps) {
    lines.push(`${step.order}. ${step.title}`);
    if (step.state !== "not_checked") lines.push(`   State: ${step.state.replaceAll("_", " ")}`);
    lines.push(`   ${step.human_boundary}`);
    if (step.command) lines.push(`   Run: ${step.command}`);
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
    case "tools": return [command("tools")];
    case "cloudflare": return [command("setup", path)];
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
    case "plaid": return [];
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
  runPlaidSetup = null,
  assertContextUnchanged = () => true,
  announce = null,
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  platformName = process.platform,
} = {}) {
  if (!TECHNICIAN_RUN_STEPS.includes(step)) {
    throw new Error(`--run accepts one of: ${TECHNICIAN_RUN_STEPS.join(", ")}`);
  }
  if (!manifestPath || !scriptPath) throw new Error("the technician step needs a manifest and installer path");
  const summary = readManifestSummary(manifestPath, manifestDeps);
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
  if (step === "plaid") {
    assertPlaidTechnicianPreflight(summary, flags, isTTY, platformName);
  }

  const secretBuffers = [];
  const explicitEnv = {};
  let childEnv = null;
  try {
    if (step === "google") {
      if (typeof readHidden !== "function") throw new Error("the Google step needs a secure interactive terminal");
      const clientId = await hiddenValue(readHidden, "  Google OAuth client ID (hidden): ", "Google OAuth client ID");
      secretBuffers.push(clientId);
      const clientSecret = await hiddenValue(readHidden, "  Google OAuth client secret, if issued (hidden; Enter for none): ", "Google OAuth client secret", { optional: true });
      secretBuffers.push(clientSecret);
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

    if (step === "plaid") {
      if (typeof readHidden !== "function" || typeof runPlaidSetup !== "function") {
        throw new Error("the Plaid step needs the reviewed secure interactive setup boundary");
      }
      await assertContextUnchanged();
      if (typeof announce === "function") {
        announce(
          `Plaid ${summary.bank_feed.environment} is selected. The exact redirect and signed-webhook URLs are recorded. ` +
            "This step changes only three Worker secrets and will not open Plaid Link or contact a bank.",
        );
        announce(
          "The owner enters the Plaid application values at the next two hidden prompts. They are not placed in the command, shell history, plan, or support note.",
        );
      }
      const clientId = await hiddenValue(readHidden, "  Plaid client ID (hidden): ", "Plaid client ID");
      secretBuffers.push(clientId);
      const clientSecret = await hiddenValue(readHidden, "  Plaid secret for the selected environment (hidden): ", "Plaid secret");
      secretBuffers.push(clientSecret);
      const proof = await runPlaidSetup({
        manifestPath: summary.path,
        environment: summary.bank_feed.environment,
        redirectUri: summary.bank_feed.redirect_uri,
        webhookUri: summary.bank_feed.webhook_uri,
        assertContextUnchanged,
        clientId,
        clientSecret,
      });
      return {
        step,
        completed: true,
        commands_run: 0,
        proof_level: "worker_secret_name_readback",
        proof,
        coordination_boundary: "single_supervised_owner_machine",
        remote_first_setup_compare_and_swap: false,
        next: ["enroll_owner_passkey", "brain_connect_bank"],
      };
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
