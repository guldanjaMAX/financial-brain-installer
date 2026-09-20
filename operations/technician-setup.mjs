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
import {
  BOOTSTRAP_SETUP_INTENTS,
  normalizeBootstrapSetupIntent,
} from "./bootstrap-status.mjs";
import { renderCopyableCommand } from "./command-display.mjs";
import { manifestHasProvisionedResourceBindings } from "./machine-continuity.mjs";

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
    proof: "after sign-in verifies the exact account, the owner confirms its account-specific dashboard because the installer's narrow session cannot read billing status",
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
    human_boundary: "The owner signs in, completes 2FA, and chooses the exact account. After Cloudflare verifies it, the installer opens that account's Workers & Pages plan page for the owner's Paid confirmation. Before any resource is created, the owner approves Cloudflare's browser consent. Normal fresh setup creates no API token. Before approval, explain that setup also adds or updates the Brain MCP entry in installed AI tools and may create a new owner-workspace CLAUDE.md. Use --no-connect if the owner declines those local config writes.",
    automated_proof: "The installer verifies the named browser sign-in and exact account, provisions that account, deploys, migrates, runs health checks, and either verifies the approved AI-tool wiring or records that --no-connect left it unchanged. The narrow sign-in does not claim to verify billing; the owner's account-specific dashboard confirmation is the plan proof.",
    owner_guidance: ownerGuidance({
      before_action: "Cloudflare's official sign-in will open first. After it verifies the selected account, the installer opens that exact account's Workers & Pages > Plans page. The owner confirms it says Paid before setup creates anything.",
      why: "The installer uses that owner-approved session to create and verify this Brain's Worker, database, meaning-search index, and Workers AI access in the selected account.",
      minimum_access: "The installer confines every action to the exact Cloudflare account the owner selects and confirms for this Brain. Normal fresh setup creates, reveals, and copies no API token.",
      browser_help: "The assistant can open the official sign-in page and continue the installer after Cloudflare returns the confirmed account.",
      owner_only: "The owner signs in, completes 2FA, selects the exact account, reviews and approves consent, then confirms that account's plan page says Paid. Any plan change or billing approval stays with the owner.",
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
export const TECHNICIAN_SETUP_INTENTS = BOOTSTRAP_SETUP_INTENTS;
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
  "CODEX_HOME",
  "BRAIN_GOOGLE_TOKEN_STORE", "BRAIN_IMAP_CREDENTIAL_STORE",
  // Non-secret, exact-account proof for an explicitly approved unattended
  // setup. The child still refuses a missing or different verified account id.
  "BRAIN_WORKERS_PAID_ACCOUNT_ID",
]);

export function technicianChildEnvironment(base = {}, explicit = {}) {
  const result = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof base[name] !== "string" || base[name] === "") continue;
    if (name === "BRAIN_WORKERS_PAID_ACCOUNT_ID" && !/^[a-f0-9]{32}$/i.test(base[name])) continue;
    result[name] = base[name];
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (typeof value === "string" && value !== "") result[name] = value;
  }
  return result;
}

function finalBrainHostname(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 253 || raw.includes("://") || !/^[a-z0-9.-]+$/i.test(raw)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const labels = hostname.split(".");
  const validLabels = labels.length >= 2 && labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!validLabels || /^\d+(?:\.\d+){3}$/.test(hostname) ||
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      parsed.pathname !== "/" || parsed.search || parsed.hash ||
      hostname !== raw.toLowerCase()) {
    return null;
  }
  return hostname;
}

function ownedPartialInstallRecord(manifest) {
  const slug = String(manifest?.client?.slug || "").trim().toLowerCase();
  const displayName = String(manifest?.client?.display_name || "").trim();
  const workerName = String(manifest?.brain?.worker_name || "").trim().toLowerCase();
  const cloudflare = manifest?.infrastructure?.cloudflare;
  const accountId = String(cloudflare?.account_id || "").trim().toLowerCase();
  const databaseName = String(cloudflare?.d1_database_name || "").trim().toLowerCase();
  const authProfile = String(cloudflare?.auth_profile || "").trim().toLowerCase();
  return manifest?.manifest_version === 1 &&
    /^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) &&
    displayName.length > 0 &&
    workerName === `${slug}-brain` &&
    /^[a-f0-9]{32}$/.test(accountId) &&
    (cloudflare?.storage ?? "d1") === "d1" &&
    databaseName === `${slug}-brain` &&
    /^financial-brain-[a-f0-9]{24}$/.test(authProfile);
}

function readManifestSummary(manifestPath, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const read = deps.readFileSync || readFileSync;
  const absolute = resolve(manifestPath);
  if (!exists(absolute)) {
    return {
      path: absolute,
      exists: false,
      record_state: "not_created",
      final_hostname: null,
      final_hostname_invalid: false,
      enabled_connectors: [],
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(read(absolute, "utf8"));
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
      throw new Error("not an object");
    }
  } catch {
    return {
      path: absolute,
      exists: true,
      record_state: "unproven",
      final_hostname: null,
      final_hostname_invalid: false,
      enabled_connectors: [],
    };
  }
  const enabled = ["google_drive", "gmail", "calendar", "zoom", "imap"]
    .filter((name) => manifest?.corpora?.[name]?.enabled === true);
  const declaredDomain = typeof manifest?.brain?.domain === "string"
    ? manifest.brain.domain.trim()
    : "";
  const finalHostname = finalBrainHostname(declaredDomain);
  const provisioned = manifestHasProvisionedResourceBindings(manifest);
  const recordState = provisioned
    ? "provisioned"
    : ownedPartialInstallRecord(manifest)
      ? "owned_partial"
      : "unproven";
  return {
    path: absolute,
    exists: true,
    record_state: recordState,
    final_hostname: finalHostname,
    final_hostname_invalid: Boolean(declaredDomain && !finalHostname),
    enabled_connectors: enabled,
  };
}

function routeCommand(cli, args, platformName, details = {}) {
  if (!cli) return null;
  return Object.freeze({
    command: cli.command,
    args: Object.freeze([...cli.args, ...args]),
    display: exactCommand(cli, args, platformName),
    ...details,
  });
}

export function technicianSetupRoute(manifest, intentValue, {
  cli = null,
  platformName = process.platform,
  intentExplicit = intentValue !== undefined && intentValue !== null && intentValue !== "",
} = {}) {
  const intent = normalizeBootstrapSetupIntent(intentValue);
  const state = manifest?.record_state || (manifest?.exists ? "unproven" : "not_created");
  const stop = (status, issueCode, ownerMessage) => Object.freeze({
    intent,
    intent_explicit: intentExplicit,
    observed_local_state: state,
    status,
    issue_code: issueCode,
    action: "stop",
    read_only_stop: true,
    creates_new_brain: false,
    next_command: null,
    owner_message: ownerMessage,
    boundaries: Object.freeze({
      selects_existing_brain_by_name: false,
      copies_credentials: false,
      opens_browser_or_prompts: false,
    }),
  });

  if (intent === "unsure") {
    return stop(
      "intent_required",
      "SETUP_INTENT_REQUIRED",
      "I could not safely choose a setup route from files on this computer. Confirm whether this is your first Brain, this Brain already works on this computer, you are reconnecting it on a new computer, or this computer's setup was interrupted. Nothing will be created while you are unsure.",
    );
  }
  if (state === "unproven") {
    return stop(
      "local_state_unproven",
      "INSTALL_RECORD_UNPROVEN",
      "A local file exists, but it is not a proven Financial Brain install record. Review or restore the exact intended manifest before any setup, recovery, provider, or source action.",
    );
  }
  if (intent === "first_brain") {
    if (state !== "not_created") {
      return stop(
        "intent_conflict",
        "INSTALL_RECORD_ALREADY_EXISTS",
        state === "owned_partial"
          ? "This computer has a saved partial install record. Fresh setup is blocked. If this is the interrupted install you recognize, choose resume_interrupted so the same record can continue without another fresh browser ceremony."
          : "This manifest already records provisioned Brain resources. Fresh setup is blocked. Choose the existing-Brain route that matches this computer.",
      );
    }
    const args = [
      "technician", manifest.path, "--intent", "first_brain", "--run", "cloudflare",
      "--browser-sign-in",
      "--name", "<person-or-company>",
      "--slug", "<short-name>",
      "--cloudflare-account", "<create-or-existing>",
      "--cloudflare-account-id", "<32-character-account-id>",
      "--workers-paid-confirmed",
    ];
    return Object.freeze({
      intent,
      intent_explicit: intentExplicit,
      observed_local_state: state,
      status: "fresh_setup_ready",
      issue_code: null,
      action: "fresh_setup",
      read_only_stop: false,
      creates_new_brain: true,
      next_command: routeCommand(cli, args, platformName, {
        mutates_external_state: true,
        requires_owner_approval: true,
      }),
      owner_message: "This is the owner's first Brain and no install record exists at the reviewed path. Fresh setup is available only after the owner approves the exact Cloudflare account and Paid-plan ceremony.",
      boundaries: Object.freeze({
        selects_existing_brain_by_name: false,
        copies_credentials: false,
        opens_browser_or_prompts: true,
      }),
    });
  }
  if (intent === "resume_interrupted") {
    if (state === "not_created") {
      return stop(
        "resume_record_missing",
        "INTERRUPTED_INSTALL_RECORD_MISSING",
        "There is no saved install record at this path, so there is nothing exact to resume. Restore the interrupted manifest before continuing; do not create a replacement or identify a Brain by name.",
      );
    }
    const args = ["technician", manifest.path, "--intent", "resume_interrupted", "--run", "cloudflare"];
    return Object.freeze({
      intent,
      intent_explicit: intentExplicit,
      observed_local_state: state,
      status: "resume_setup_ready",
      issue_code: null,
      action: "resume_setup",
      read_only_stop: false,
      creates_new_brain: false,
      next_command: routeCommand(cli, args, platformName, {
        mutates_external_state: true,
        requires_owner_approval: true,
      }),
      owner_message: "The exact saved install record will be reused. The resume does not rewrite the manifest from a name, repeat fresh browser sign-in, or ask anyone to copy a credential.",
      boundaries: Object.freeze({
        selects_existing_brain_by_name: false,
        copies_credentials: false,
        opens_browser_or_prompts: false,
      }),
    });
  }
  if (intent === "existing_new_computer" && state === "not_created") {
    return stop(
      "existing_brain_recovery_required",
      "EXISTING_BRAIN_RECOVERY_REQUIRED",
      "I could not find this Brain's install record on the new computer. Recover the exact manifest and owner-custody path from a surviving device or reviewed backup before running continuity checks. Missing files do not authorize a new Brain.",
    );
  }
  if (intent === "existing_this_computer" && state === "not_created") {
    return stop(
      "expected_local_record_missing",
      "EXPECTED_LOCAL_INSTALL_RECORD_MISSING",
      "This route expects the Brain's exact install record on this computer, but it is missing at the reviewed path. Confirm or recover that path before continuing. Fresh setup is blocked.",
    );
  }
  if (state === "owned_partial") {
    return stop(
      "interrupted_setup_confirmation_required",
      "INTERRUPTED_INSTALL_CONFIRMATION_REQUIRED",
      "This exact local record is partial. Confirm that setup was interrupted on this computer, then choose resume_interrupted. It will reuse this record without a fresh browser ceremony.",
    );
  }

  const args = ["machine-continuity", manifest.path, "--json"];
  return Object.freeze({
    intent,
    intent_explicit: intentExplicit,
    observed_local_state: state,
    status: "continuity_check_ready",
    issue_code: null,
    action: "machine_continuity",
    read_only_stop: false,
    creates_new_brain: false,
    next_command: routeCommand(cli, args, platformName, {
      mutates_external_state: false,
      requires_owner_approval: false,
    }),
    owner_message: intent === "existing_new_computer"
      ? "The recovered exact manifest can now be checked for this computer's local owner credential, assistant connection, sources, schedulers, and resume checkpoints. The check is read-only."
      : "This Brain already has provisioned resources. Run the read-only continuity check before any local repair or update.",
    boundaries: Object.freeze({
      selects_existing_brain_by_name: false,
      copies_credentials: false,
      opens_browser_or_prompts: false,
    }),
  });
}

export function technicianPlan(manifestPath, deps = {}) {
  if (!manifestPath || String(manifestPath).startsWith("--")) {
    throw new Error("usage: brain technician <manifest> --intent <first_brain|existing_this_computer|existing_new_computer|resume_interrupted|unsure> [--json] [--run <step>]");
  }
  const manifest = readManifestSummary(manifestPath, deps);
  const platformName = deps.platformName ?? process.platform;
  const cli = cliLocator(deps.cli);
  const intentValue = deps.intent;
  const routing = technicianSetupRoute(manifest, intentValue, {
    cli: cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) }),
    platformName,
    intentExplicit: intentValue !== undefined && intentValue !== null && intentValue !== "",
  });
  const refresh = cli
    ? Object.freeze({
        command: cli.command,
        args: Object.freeze([
          ...cli.args,
          "technician", manifest.path, "--intent", routing.intent, "--json",
        ]),
        mutates_external_state: false,
      })
    : null;
  return {
    schema_version: 5,
    mode: "read_only_plan",
    proof_level: "workflow_only",
    manifest,
    routing,
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
    interaction: TECHNICIAN_INTERACTION_POLICY,
    prerequisites: TECHNICIAN_PREREQUISITES,
    coverage: {
      bank_connections: {
        state: "held_outside_ordinary_onboarding",
        credentials_needed_here: false,
        owner_message: "Bank connections are not part of ordinary onboarding yet. They are still being tested. You did nothing wrong, and there is no bank password, verification code, or Plaid setup key to enter here. An already approved pilot keeps its complete existing bank setup. If any piece is missing, setup stops before changing a credential and explains the separately reviewed next step.",
      },
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
      "Before setup, require Node 22+, 2 GiB free on the actual install drive, and a normal non-elevated user terminal.",
      "After Cloudflare verifies the exact account, require the owner to confirm its Workers & Pages > Plans page says Paid before creating any resource; the narrow sign-in cannot prove billing. Apply this to fresh, resumed, recovery, and automation setup paths.",
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
    ],
    steps: TECHNICIAN_STEPS.map((step, index) => {
      let state = "not_checked";
      if (step.id === "tools") state = "ready_to_start";
      if (step.id === "cloudflare") state = routing.status;
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
      if (step.id === "passkey" && manifest.exists && manifest.final_hostname_invalid) {
        state = "invalid_final_hostname";
      } else if (step.id === "passkey" && manifest.exists && !manifest.final_hostname) {
        state = "waiting_for_final_hostname";
      }
      if (DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id)) {
        state = "deferred_from_public_first_install";
      }
      const ownerOnly = step.id === "passkey";
      const agentAfterOwnerApproval = step.id === "cloudflare" &&
        ["fresh_setup", "resume_setup"].includes(routing.action);
      const ownerCli = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
      const ownerArgs = step.id === "passkey"
        ? ["invite", manifest.path]
        : ["technician", manifest.path, "--intent", routing.intent, "--run", step.id];
      const approvedAgentArgs = routing.next_command?.args.slice(ownerCli.args.length) || [];
      const routedStep = step.id === "cloudflare" && routing.action === "resume_setup"
        ? {
            ...step,
            title: "Resume this Brain's saved setup",
            dashboard_url: null,
            human_boundary: "The owner reviews and approves resuming the exact saved manifest. The installer reuses its saved account and protected sign-in profile, and stops on any mismatch or expired access instead of opening a fresh ceremony.",
            automated_proof: "The same manifest-bound setup command verifies every saved resource and resumes its idempotent checkpoint. It does not select a Brain by name or copy a credential.",
            owner_guidance: ownerGuidance({
              before_action: "The installer will continue the exact saved setup record from its verified checkpoint. No fresh manifest or Cloudflare browser ceremony will be started.",
              why: "This finishes the interrupted Brain without creating a second Brain or repeating already saved ownership steps.",
              minimum_access: "Only the account and protected local sign-in profile already bound to this exact manifest.",
              browser_help: "No browser should open. If any unexpected sign-in or account-selection page appears, stop and review it before continuing.",
              owner_only: "The owner approves this exact resume. Any unexpected identity, account, billing, or sign-in request stops the step.",
              privacy: "No credential is copied into chat, a command, or the manifest.",
            }),
          }
        : step;
      return {
        order: index + 1,
        ...routedStep,
        command: DEFERRED_PUBLIC_CONNECTOR_STEPS.includes(step.id) || ownerOnly || step.id === "cloudflare"
          ? null
          : technicianDisplayCommand(step.id, manifest.path, cli, platformName, routing.intent),
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
        ...(step.id === "cloudflare" && routing.action === "machine_continuity"
          ? {
              represented_by_install_record: true,
              existing_install_guidance: `${routing.owner_message} Run: ${routing.next_command?.display || "brain machine-continuity <manifest> --json"}`,
            }
          : {}),
        ...(step.id === "cloudflare" && routing.action === "stop"
          ? {
              routing_stop: true,
              existing_install_guidance: routing.owner_message,
            }
          : {}),
      };
    }),
  };
}

export function technicianDisplayCommand(
  step,
  manifestPath,
  cli = null,
  platformName = process.platform,
  intent = "unsure",
) {
  const path = resolve(manifestPath);
  const locator = cli || Object.freeze({ command: "<brain-cli>", args: Object.freeze([]) });
  const routed = ["technician", path, "--intent", normalizeBootstrapSetupIntent(intent), "--run"];
  if (step === "google") return exactCommand(locator, [...routed, "google"], platformName);
  if (step === "imap") return exactCommand(locator, [...routed, "imap", "--host", "<imap-host>", "--user", "<email-address>"], platformName);
  if (step === "passkey") return exactCommand(locator, [...routed, "passkey", "--confirm-host", "<final-hostname>"], platformName);
  return exactCommand(locator, [...routed, step], platformName);
}

export function renderTechnicianPlan(plan) {
  const lines = [
    "",
    "Financial Brain technician setup",
    "================================",
    `Manifest: ${plan.manifest.path}`,
    `Install record: ${plan.manifest.record_state.replaceAll("_", " ")}, live state not checked`,
    `Owner route: ${plan.routing.intent.replaceAll("_", " ")}`,
    `Routing result: ${plan.routing.status.replaceAll("_", " ")}`,
    `Final hostname: ${plan.manifest.final_hostname || "not fixed yet"}`,
    "",
    "This screen prepares the visit. Each live check will add its own proof.",
    "We will do one small action at a time and explain each page or prompt before it opens.",
    "When browser help is available, it can handle official-page navigation and non-secret fields.",
    "The owner takes over for login, 2FA, consent, billing, credentials, and physical passkey prompts.",
    "Sensitive values stay in provider pages or hidden terminal prompts.",
    "Local configuration writes are named before approval. Setup can use --no-connect when the owner wants AI-tool files left unchanged.",
    plan.routing.owner_message,
    plan.warning,
    plan.coverage.bank_connections.owner_message,
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
    else if (step.represented_by_install_record || step.routing_stop) lines.push(`   ${step.existing_install_guidance}`);
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

function childCommands(step, manifestPath, flags, scriptPath, routing = null) {
  const path = resolve(manifestPath);
  const command = (...args) => [scriptPath, ...args];
  switch (step) {
    // The technician step is stricter than a read-only bootstrap snapshot. It
    // must not report completion from an agent shell when Claude's interactive
    // installation doctor was never able to run.
    case "tools": return [command(
      "tools",
      path,
      "--intent",
      routing?.intent || "unsure",
      "--require-doctor",
    )];
    case "cloudflare": {
      if (routing?.action === "resume_setup") {
        const freshOnly = [
          "browser-sign-in", "name", "slug", "cloudflare-account",
          "cloudflare-account-id", "workers-paid-confirmed",
        ].filter((name) => flags[name] !== undefined);
        if (freshOnly.length) {
          throw new Error(
            `the resume route does not accept fresh-setup options: ${freshOnly.map((name) => `--${name}`).join(", ")}`,
          );
        }
        if (flags["no-connect"] !== undefined && flags["no-connect"] !== true) {
          throw new Error("--no-connect is an approval switch and does not take a value");
        }
        return [command("setup", path, ...(flags["no-connect"] === true ? ["--no-connect"] : []))];
      }
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
      "this connector needs private credential entry, and this release does not include a verified Windows secret-entry bridge for Claude Code. " +
        "The generic terminal prompt can echo secrets, so the technician stops before asking for one or launching the connector. " +
        "Do not place the credential in a command or persistent environment variable.",
      "windows_secure_input_unavailable",
    );
  }
  const summary = readManifestSummary(manifestPath, manifestDeps);
  const routing = technicianSetupRoute(summary, flags.intent, {
    intentExplicit: flags.intent !== undefined,
    platformName,
  });
  if (step === "cloudflare" && !["fresh_setup", "resume_setup"].includes(routing.action)) {
    throw codedError(routing.owner_message, routing.issue_code || "TECHNICIAN_ROUTE_BLOCKED");
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
    if (summary.final_hostname_invalid) {
      throw new Error(
        "brain.domain must be one final hostname with no scheme, port, path, credentials, query, or fragment before passkey enrollment.",
      );
    }
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

    if (step === "cloudflare") {
      const paidAccountId = typeof flags["cloudflare-account-id"] === "string"
        ? flags["cloudflare-account-id"].trim().toLowerCase()
        : "";
      if (flags["workers-paid-confirmed"] === true && /^[a-f0-9]{32}$/.test(paidAccountId)) {
        explicitEnv.BRAIN_WORKERS_PAID_ACCOUNT_ID = paidAccountId;
      }
    }

    childEnv = technicianChildEnvironment(baseEnv, explicitEnv);
    const commands = childCommands(step, manifestPath, flags, resolve(scriptPath), routing);
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
