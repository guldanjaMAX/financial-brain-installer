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

function ownerGuidance({ before_action, why, minimum_access, browser_help, owner_only, privacy }) {
  return Object.freeze({ before_action, why, minimum_access, browser_help, owner_only, privacy });
}

export const TECHNICIAN_INTERACTION_POLICY = Object.freeze({
  one_action_at_a_time: true,
  browser_assistance:
    "When browser control is available, the assistant offers to handle official-page navigation and non-secret form fields after the owner approves the exact step.",
  owner_handoff:
    "The assistant stops before sign-in, 2FA, credential reveal or entry, OAuth consent, billing approval, and every passkey system prompt.",
  unexpected_screen:
    "If the page or prompt differs from the explanation, stop and explain the difference before anyone clicks or enters anything.",
});

export const TECHNICIAN_PREREQUISITES = Object.freeze([
  Object.freeze({
    id: "node",
    requirement: "Node.js 22 or newer",
    proof: "brain tools checks the running Node version before setup",
  }),
  Object.freeze({
    id: "install_drive",
    requirement: "At least 2 GiB free on the actual per-user install drive, using LOCALAPPDATA on Windows",
    proof: "brain tools reads free space on that drive before setup",
  }),
  Object.freeze({
    id: "install_session",
    requirement: "A normal current-user terminal, without sudo, root, or Run as administrator",
    proof: "brain tools stops if the session is elevated or cannot be verified",
  }),
  Object.freeze({
    id: "cloudflare_account",
    requirement: "A Cloudflare account the owner chooses for this Brain",
    proof: "the named browser sign-in verifies the exact reachable account before provisioning",
  }),
  Object.freeze({
    id: "workers_paid",
    requirement: "Workers & Pages > Plans must show Paid before any Brain resource is created",
    proof: "the owner confirms the dashboard because the installer's narrow session cannot read billing status",
  }),
]);

export const TECHNICIAN_STEPS = Object.freeze([
  Object.freeze({
    id: "tools",
    title: "Check this computer and install the owner tools",
    dashboard_url: "https://financialbrain.ai/install",
    human_boundary: "Before approval, explain that this step installs or updates the reviewed technician skill for Claude Code, and for Codex only when Codex is already present, records local bootstrap status, and may add the Brain CLI folder to PATH. The owner uses a normal, non-Administrator terminal and signs in to Claude in their browser. The technician runs Anthropic's interactive doctor with Claude Code's normal approval prompts enabled.",
    automated_proof: "Before setup, the installer verifies Node 22+, at least 2 GiB free on the actual per-user install drive, a non-elevated current-user session, Claude CLI version and sign-in, the personal /financial-brain-technician skill in each installed AI client, bootstrap status, PATH, Anthropic's doctor, and pinned Wrangler 4 with a credential-scrubbed environment.",
    owner_guidance: ownerGuidance({
      before_action: "First, the installer will read this computer's Node version, free space, and user-session type. If those pass, Claude Code may open its official sign-in page and installation check.",
      why: "This prevents a partial install owned by Administrator or stranded on a full drive, and makes sure the owner's everyday assistant and reviewed guide are ready before any account or private data is touched.",
      minimum_access: "Read-only machine checks, Node.js 22 or newer, 2 GiB free on the actual install drive, and Claude sign-in only. This requests no Cloudflare, provider, source, or Brain access.",
      browser_help: "The assistant can open the official page and continue the local checks after sign-in succeeds.",
      owner_only: "The owner signs in, completes 2FA, and answers any Claude account prompt.",
      privacy: "No Cloudflare token, Brain key, source credential, or private document belongs in this step.",
    }),
  }),
  Object.freeze({
    id: "cloudflare",
    title: "Install the private Brain",
    dashboard_url: "https://dash.cloudflare.com/",
    human_boundary: "The owner signs in, completes 2FA, chooses the exact account, and confirms Workers & Pages > Plans says Paid. Before any resource is created, the owner approves Cloudflare's browser consent. Normal fresh setup creates no API token. Before approval, explain that setup also adds or updates the Brain MCP entry in installed AI tools and may create a new owner-workspace CLAUDE.md. Use --no-connect if the owner declines those local config writes.",
    automated_proof: "The installer verifies the named browser sign-in and exact account, provisions that account, deploys, migrates, runs health checks, and either verifies the approved AI-tool wiring or records that --no-connect left it unchanged. The narrow sign-in does not claim to verify billing; the owner's dashboard confirmation is the plan proof.",
    owner_guidance: ownerGuidance({
      before_action: "Cloudflare's official page will open. Before setup creates anything, the owner confirms the intended account shows Workers & Pages > Plans > Paid, then approves this Brain's named local browser session.",
      why: "The installer uses that owner-approved session to create and verify this Brain's Worker, database, meaning-search index, and Workers AI access in the selected account.",
      minimum_access: "The installer confines every action to the exact Cloudflare account the owner selects and confirms for this Brain. Normal fresh setup creates, reveals, and copies no API token.",
      browser_help: "The assistant can open the official sign-in page and continue the installer after Cloudflare returns the confirmed account.",
      owner_only: "The owner signs in, completes 2FA, selects the exact account, confirms Plans says Paid, then reviews and approves consent. Any plan change or billing approval stays with the owner.",
      privacy: "The protected browser session stays in the owner's operating-system credential store. The assistant must not inspect or export it. This narrow sign-in does not verify billing; the owner's dashboard confirmation is the plan proof.",
    }),
  }),
  Object.freeze({
    id: "smoke",
    title: "Load the non-private first-install smoke document",
    dashboard_url: null,
    human_boundary: "The owner approves one fixed, public, non-customer smoke document and its tiny Workers AI embedding cost. No local file, account credential, or customer content is read.",
    automated_proof: "The installer posts the fixed document through the deployed authenticated ingest boundary, requires its exact per-document receipt, records a ready manual source receipt, drains the vector work, and leaves the document in the owner's Brain as durable first-install evidence.",
    owner_guidance: ownerGuidance({
      before_action: "The installer will add one fixed public test note to the new Brain.",
      why: "This proves the real private ingest and meaning-search path before any owner document is considered.",
      minimum_access: "Only the fixed public test note and its small Workers AI embedding cost.",
      browser_help: "No browser or provider account is needed.",
      owner_only: "The owner approves this exact test write and cost before it runs.",
      privacy: "No local file, private content, or source credential is read.",
    }),
  }),
  Object.freeze({
    id: "google",
    title: "Connect Google Drive, Gmail, and Calendar",
    dashboard_url: "https://console.cloud.google.com/apis/credentials",
    human_boundary: "The owner chooses or creates the Google project and approves the OAuth consent screen in their browser.",
    automated_proof: "The connector stores the refresh grant locally and dry-runs each requested Google source.",
    owner_guidance: ownerGuidance({
      before_action: "Google Cloud's official console will open to prepare a Desktop OAuth client, followed by Google's account consent page.",
      why: "This gives the owner's Brain a revocable local connection to only the Google sources approved in the manifest.",
      minimum_access: "Only the Drive, Gmail, and Calendar scopes for sources the owner has enabled. Do not add another Google API or scope for convenience.",
      browser_help: "After exact approval, the assistant can navigate, fill non-secret project and app labels, choose Desktop app, enable the approved APIs, and select the reviewed scope choices.",
      owner_only: "The owner signs in, completes 2FA, confirms the Google account, approves OAuth consent, and enters any revealed client value directly into the hidden terminal prompt.",
      privacy: "The assistant must stop for every credential reveal or consent screen and must not read, copy, screenshot, transcribe, or store the value.",
    }),
  }),
  Object.freeze({
    id: "zoom",
    title: "Connect Zoom cloud transcripts",
    dashboard_url: "https://marketplace.zoom.us/develop/create",
    human_boundary: "A Zoom admin creates a Server-to-Server OAuth app, grants the recording scope, and later saves the verified webhook subscription.",
    automated_proof: "The connector probes the account and plan, writes Worker secrets, proves the live webhook challenge, and only then prints the URL to save.",
    owner_guidance: ownerGuidance({
      before_action: "Zoom's official App Marketplace will open to prepare a Server-to-Server OAuth app and one transcript event subscription.",
      why: "This lets the Brain receive completed cloud-recording transcripts from the approved Zoom account.",
      minimum_access: "cloud_recording:read:admin for transcripts, user:read:admin only for the plan check, and recording.transcript_completed for delivery.",
      browser_help: "After exact approval, the assistant can navigate and fill non-secret app labels, scope choices, and the verified event-subscription fields.",
      owner_only: "A Zoom admin signs in, completes 2FA, approves the app and scopes, and enters every revealed account or client value into the hidden terminal prompt.",
      privacy: "The assistant must stop before a credential is revealed and must not read, copy, screenshot, transcribe, or store it.",
    }),
  }),
  Object.freeze({
    id: "imap",
    title: "Connect an IMAP mailbox",
    dashboard_url: null,
    human_boundary: "The mailbox owner creates an app password in their provider and enters it only into the hidden terminal prompt.",
    automated_proof: "The connector performs a real read before storing the app password locally.",
    owner_guidance: ownerGuidance({
      before_action: "The mailbox provider's official security page may open to create a separate app password for this mail connection.",
      why: "The separate credential lets the Brain read the approved mailbox without using or storing the owner's normal mailbox password.",
      minimum_access: "Mail access only, using a revocable app password when the provider supports one. Do not request contacts, calendar, sending, or account-management access.",
      browser_help: "After exact approval, the assistant can find the provider's official app-password page and fill non-secret labels or mail-host settings.",
      owner_only: "The owner signs in, completes 2FA, approves creation, and enters the displayed app password directly into the hidden terminal prompt.",
      privacy: "The assistant must stop before the app password is displayed and must not read, copy, screenshot, transcribe, or store it.",
    }),
  }),
  Object.freeze({
    id: "plaid",
    title: "Prepare the native Plaid connection",
    dashboard_url: "https://dashboard.plaid.com/team/api",
    human_boundary: "Inside an approved, version-scoped field plan, the owner confirms the selected Plaid environment and Production access when applicable, then verifies the exact redirect and webhook URLs in their own Plaid dashboard. The client ID and secret go only into hidden prompts.",
    automated_proof: "The installer generates or reuses an independent protected wrapping key, atomically applies only the three bank-feed Worker secrets, and reads back only those three binding names. It does not open Link or contact a bank.",
    owner_guidance: ownerGuidance({
      before_action: "Plaid's official dashboard will open for the selected environment so the exact Brain redirect and webhook URLs can be registered before any application value is entered.",
      why: "This prepares the native bank feed inside the approved, version-scoped field plan without opening Link or contacting a bank.",
      minimum_access: "Only the exact redirect and webhook URLs plus the three reviewed bank-feed Worker secret bindings. Do not request another product, scope, or environment for convenience.",
      browser_help: "After exact approval, the assistant can navigate and fill the two non-secret Brain URLs in the selected Plaid environment.",
      owner_only: "The owner signs in, completes 2FA, confirms Sandbox or Production access, approves the final dashboard save, and enters each revealed application value directly into the hidden terminal prompt.",
      privacy: "The assistant must stop before a client ID or secret is revealed and must not read, copy, screenshot, transcribe, or store it.",
    }),
  }),
  Object.freeze({
    id: "passkey",
    title: "Enroll the owner passkey",
    dashboard_url: null,
    human_boundary: "The agent explains the passkey ceremony first. The owner runs the invite command in a directly controlled terminal, opens the private 15-minute link on their device, checks the final Brain hostname, chooses Create my owner passkey, and completes the device's own Face ID, Touch ID, fingerprint, security-key, or PIN prompt themselves.",
    automated_proof: "The live Brain records privacy-safe ceremony outcome and timing. A local rehearsal cannot prove the physical-device ceremony.",
    owner_guidance: ownerGuidance({
      before_action: "After the owner opens the one-time link, the Brain page explains the step. Choosing Create my owner passkey then opens the device's secure passkey window.",
      why: "The passkey confirms that this is the owner and protects the private owner area without creating another password.",
      minimum_access: "One owner sign-in credential for this exact Brain hostname. It does not connect files, messages, accounts, or any other part of the device.",
      browser_help: "The assistant can explain the page, but the owner opens the private link and controls the secure device window.",
      owner_only: "The owner chooses Create my owner passkey, then follows the device window using Face ID, fingerprint, device PIN, or screen lock. Cancel if the hostname or prompt is unexpected.",
      privacy: "Financial Brain and the assistant cannot see or store the owner's passkey, Face ID, fingerprint, or device PIN. The device keeps the secret; the Brain receives only the public sign-in record.",
    }),
  }),
  Object.freeze({
    id: "verify",
    title: "Run the handoff checks",
    dashboard_url: null,
    human_boundary: "The technician reviews each result and keeps unavailable connector or passkey checks clearly marked for follow-up.",
    automated_proof: "Doctor, health, source freshness, and enrolled-device checks run in order and stop on the first failure.",
    owner_guidance: ownerGuidance({
      before_action: "The installer will read the finished setup checks in order and stop if any result needs attention.",
      why: "This separates what is verified now from what still needs a live provider, source, or device check.",
      minimum_access: "Read-only health, source freshness, and enrolled-device status. No passkey is created and no device is changed.",
      browser_help: "No browser action is normally needed. If a result names a provider action, explain it before opening anything.",
      owner_only: "The owner confirms any unresolved account or device question rather than guessing from a label.",
      privacy: "Keep credentials, private source content, and one-time links out of the result record.",
    }),
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
    schema_version: 4,
    mode: "read_only_plan",
    proof_level: "workflow_only",
    manifest,
    cli,
    refresh,
    warning: "This plan prepares the workflow. The Plaid step is limited to an approved, version-scoped field plan while general bank invitations remain held. Live proof arrives during the account, connector, webhook, mailbox, and physical passkey checks.",
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
    interaction: TECHNICIAN_INTERACTION_POLICY,
    prerequisites: TECHNICIAN_PREREQUISITES,
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
      "In Claude Code, offer browser help once. When accepted and available, handle ordinary navigation and non-secret forms instead of assigning dashboard homework to the owner.",
      "Before setup, require Node 22+, 2 GiB free on the actual install drive, and a normal non-elevated user terminal.",
      "Before creating any Cloudflare resource, require the owner to confirm Workers & Pages > Plans says Paid for the exact account; the narrow sign-in cannot prove billing.",
      "Before any provider page or system prompt, explain what will appear, why it is needed, and the one action the owner should take next.",
      "Offer browser help for official-page navigation and non-secret fields, then hand control back before sign-in, 2FA, a credential, consent, billing, or a passkey prompt.",
      "Keep tokens, client secrets, app passwords, invite codes, and authentication codes in provider pages or hidden terminal prompts.",
      "Stop browser observation before any secret is revealed and resume only after the owner says it is hidden again.",
      "Fresh Cloudflare setup uses browser sign-in without an API token. Treat token creation as recovery only.",
      "Before brain tools, disclose its technician-skill, bootstrap-status, and PATH writes and get approval.",
      "Before normal setup, disclose its MCP and possible new workspace-guide writes. Use --no-connect if the owner declines, then preview before any later --apply.",
      "The owner handles login, 2FA, consent, billing, and physical-device prompts.",
      "An agent explains the passkey ceremony but never runs or captures brain invite because its output contains the private one-time link.",
      "Enroll the first passkey only after the final Brain hostname is fixed.",
      "Run the Plaid ceremony only inside a named, version-scoped disposable-candidate plan or a separately approved production pilot while general invitations remain held.",
    ],
    steps: TECHNICIAN_STEPS.map((step, index) => {
      let state = "not_checked";
      if (step.id === "tools") state = "ready_to_start";
      if (step.id === "cloudflare" && !manifest.exists) state = "ready_after_local_tools";
      if (step.id === "cloudflare" && manifest.exists) state = "represented_by_install_record";
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
      const ownerOnly = ["plaid", "passkey"].includes(step.id);
      const agentAfterOwnerApproval = step.id === "cloudflare" && !manifest.exists;
      const ownerCli = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
      const ownerArgs = step.id === "passkey"
        ? ["invite", manifest.path]
        : plaidTechnicianArgs(manifest.path, manifest.bank_feed);
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
    "We will do one small action at a time and explain each page or prompt before it opens.",
    "When browser help is available, it can handle official-page navigation and non-secret fields.",
    "The owner takes over for login, 2FA, consent, billing, credentials, and physical passkey prompts.",
    "Sensitive values stay in provider pages or hidden terminal prompts.",
    "Local configuration writes are named before approval. Setup can use --no-connect when the owner wants AI-tool files left unchanged.",
    "",
    "Before setup can create anything:",
    ...plan.prerequisites.map((item) => `- ${item.requirement}`),
    "",
  ];
  for (const step of plan.steps) {
    lines.push(`${step.order}. ${step.title}`);
    if (step.state !== "not_checked") lines.push(`   State: ${step.state.replaceAll("_", " ")}`);
    lines.push(`   What to expect: ${step.owner_guidance.before_action}`);
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

export function renderTechnicianStepBriefing(stepOrId) {
  const step = typeof stepOrId === "string"
    ? TECHNICIAN_STEPS.find((candidate) => candidate.id === stepOrId)
    : stepOrId;
  if (!step?.owner_guidance) throw new Error("the technician step has no owner briefing");
  const guidance = step.owner_guidance;
  return [
    "",
    `Before we start: ${step.title}`,
    "--------------------------------",
    `What will happen: ${guidance.before_action}`,
    `Why this helps: ${guidance.why}`,
    `Smallest access: ${guidance.minimum_access}`,
    `Browser help: ${guidance.browser_help}`,
    `Your part: ${guidance.owner_only}`,
    `Privacy: ${guidance.privacy}`,
    "",
  ].join("\n");
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
  if (platformName === "win32" && ["google", "zoom", "imap"].includes(step)) {
    throw codedError(
      "this connector needs private credential entry, and this release does not include a verified Windows secret-entry bridge for Claude Code. " +
        "The generic terminal prompt can echo secrets, so the technician stops before asking for one or launching the connector. " +
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
