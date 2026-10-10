/**
 * Human recovery guidance for every privacy-safe installer issue code.
 *
 * The code is the durable identity. These sentences may improve without
 * changing journal records, automation, or support searches. Guidance stays
 * intentionally general: private paths, account identifiers, provider text,
 * and credentials belong neither here nor in the support journal.
 */

import { SUPPORT_ERROR_CODES } from "./support-journal.mjs";
import { WINDOWS_KEYRING_RECOVERY } from "./operations/cloudflare-keyring-guidance.mjs";

const RETRY_STATES = new Set(["safe_now", "safe_after_step", "review_first"]);

const entry = (code, title, whatHappened, protection, retry, nextSteps, technicianWhen) => Object.freeze({
  code,
  title,
  what_happened: whatHappened,
  protection,
  retry,
  next_steps: Object.freeze(nextSteps),
  technician_when: technicianWhen,
});

const OPERATIONAL_STATUS_CODES = Object.freeze([
  "BOOTSTRAP_READY_NO_MANIFEST",
  "CLAUDE_DOCTOR_FAILED",
  "CLAUDE_DOCTOR_REQUIRES_INTERACTIVE_TERMINAL",
  "CLAUDE_HANDOFF_FAILED",
  "CLAUDE_NATIVE_EXECUTABLE_REQUIRED",
  "CLAUDE_PATH_RUNTIME_UNAVAILABLE",
  "CLAUDE_PATH_UPDATE_FAILED",
  "CLAUDE_WORKSPACE_COLLISION",
  "CLAUDE_WORKSPACE_UNAVAILABLE",
  "CLOUDFLARE_ACCOUNT_MISMATCH",
  "CLOUDFLARE_PERMISSION_MISSING",
  "ELEVATED_INSTALL_SESSION",
  "EXISTING_BRAIN_RECOVERY_REQUIRED",
  "EXPECTED_LOCAL_INSTALL_RECORD_MISSING",
  "INSTALLED_VERSION_DIFFERS",
  "INSTALL_DRIVE_SPACE_LOW",
  "INSTALL_RECORD_ALREADY_EXISTS",
  "INSTALL_RECORD_PARTIAL",
  "INSTALL_RECORD_PARTIAL_RESUME",
  "INSTALL_RECORD_RESUME_REQUESTED",
  "LOCAL_CREDENTIAL_MISSING",
  "MIGRATION_INCOMPATIBLE",
  "RUNTIME_UNAVAILABLE",
  "SETUP_INTENT_REQUIRED",
  "TECHNICIAN_ROUTE_BLOCKED",
  "TECHNICIAN_SKILL_UNAVAILABLE",
  "WINDOWS_DPAPI_CLEANUP_DEFERRED",
  "WINDOWS_DPAPI_UNKNOWN",
  "WRANGLER_UNAVAILABLE",
]);

const CATALOG = [
  entry("PROVENANCE_TARGET_REPAIR_INCOMPLETE", "The one-file repair needs another review", "The repair could not verify that the selected file is completely represented and searchable.", "Nothing was lost. Accepted progress is saved and the original file is unchanged.", "review_first", ["Run a new read-only preview before retrying.", "If the repair is still incomplete, ask support to review this issue code."], "A fresh preview cannot resolve the incomplete repair or reports preserved documents."),
  entry("ADMIN_KEY_MISMATCH", "This computer's key was not accepted", "Your Brain didn't accept this computer's key after 15 tries.", "Your documents are safe and nothing changed.", "safe_after_step", ["Run brain setup <manifest>. It puts the saved key back on your Brain without asking you to type it.", "Then run brain health again."], "Setup finishes but Brain health still says this computer's key was not accepted."),
  entry("AUTH_DENIED", "Sign-in was not approved", "The provider or account owner declined the sign-in request.", "The connection was left unchanged.", "safe_after_step", ["Open the sign-in step again when the owner is ready.", "Approve only the access shown on the provider screen, then retry the same Brain step."], "The provider keeps declining a request the owner has approved."),
  entry("AUTH_EXPIRED", "The connection needs a fresh sign-in", "A previously approved session or token is no longer accepted.", "Stored documents remain in place while the connector waits.", "safe_after_step", ["Run the matching connection step and complete sign-in again.", "Retry the same refresh after the connection check passes."], "A fresh sign-in succeeds but the Brain still reports this code."),
  entry("AUTH_REQUIRED", "A sign-in or credential is still needed", "This step reached a protected service without a usable authorization.", "The installer paused before relying on missing access.", "safe_after_step", ["Return to the matching technician step for Cloudflare, Google, Zoom, or IMAP.", "Enter any sensitive value only in the provider page or hidden terminal prompt, then retry."], "It is unclear which account or provider step is missing."),
  entry("CLOUDFLARE_KEYRING_UNAVAILABLE", "Cloudflare protected storage needs attention", "The keyring step could not use this computer's protected credential store.", "No new browser profile was recorded and encrypted storage remains required.", "safe_after_step", ["Confirm this computer's protected credential store is available.", "Then retry the same command."], "The protected credential store remains unavailable after retrying."),
  entry("BRAIN_DOMAIN_MISSING", "The Brain address is not saved", "The manifest has no verified Brain hostname for this source command.", "The command stopped before reading a credential or contacting any address.", "safe_after_step", ["Restore brain.domain from a known-good manifest backup, or use brain health in an interactive terminal to prove the deployed hostname.", "Retry the same source command after the verified hostname is saved."], "The manifest backup and brain health disagree about the deployed hostname."),
  entry("CLOUDFLARE_TOKEN_NOT_ACTIVE", "Cloudflare did not accept the access key", "Cloudflare code 9109 usually means the key's start date is later than now or its end date has passed.", "Nothing in the Brain changed because the request was refused.", "safe_after_step", ["In Cloudflare open My Profile > API Tokens, set the start date to today or earlier and the end date at least a week away.", "If you made a new key, first run brain token <manifest> --forget, then run the same command again."], "Cloudflare still returns code 9109 after the dates and the saved key are confirmed."),
  entry("CLOUDFLARE_WORKERS_SUBDOMAIN_UNREGISTERED", "This Cloudflare account has no workers.dev subdomain yet", "Cloudflare sign-in worked, but the account has not registered the workers.dev subdomain that this Brain's address lives on.", "Setup stopped before creating anything, so there is nothing to undo.", "safe_after_step", ["In the Cloudflare dashboard, open Workers & Pages and register a workers.dev subdomain for this account.", "Then rerun the same brain setup, brain update, or brain deploy command with the same manifest."], "Workers & Pages already shows a registered workers.dev subdomain for the account this Brain uses."),
  entry("COMMAND_FAILED", "The command stopped before it finished", "Something named in the red line needs fixing first.", "Nothing that already finished was undone.", "safe_now", ["Fix that one thing, then run the same command again.", "If it stops again, open the private issue note with brain support --preview."], "The same command stops twice at the same point."),
  entry("CONFIG_INVALID", "One setup value needs attention", "A manifest value, option, filename, or command choice was missing or did not match the expected shape.", "The installer paused before using an ambiguous configuration.", "safe_after_step", ["Review the named field or option in the message above.", "Correct that one value and retry the same command."], "The suggested value is unclear or changing it could select a different account."),
  entry("EXTRACTION_FAILED", "One file could not be read", "The file opened, but its text could not be extracted reliably.", "Other documents and the source cursor stay protected from a false complete result.", "safe_after_step", ["Open the file locally to confirm it is readable.", "Use a clean export or OCR-ready copy, then retry the same source."], "Several ordinary files of the same type fail together."),
  entry("FORMAT_UNSUPPORTED", "This file type is not supported yet", "The selected file does not match a format this ingestion path can read safely.", "The file was left unchanged and was not represented as successfully indexed.", "review_first", ["Check the supported-format list for this source.", "Export the item as a supported text, PDF, Office, mail, or bank format and preview it before loading."], "The format is listed as supported but still receives this code."),
  entry("HEALTH_CHECK_FAILED", "The Brain is reachable only in part", "One or more live health checks could not confirm a ready install.", "The result stays unavailable or degraded instead of looking healthy.", "safe_now", ["Run brain health with the same manifest once more.", "If the same section remains unavailable, run brain doctor and follow its named recovery step."], "Health and doctor disagree, or the same check remains unavailable."),
  entry("INDEX_WRITE_FAILED", "Search is still catching up", "New documents are saved and can already be found by their exact words.", "The durable queue keeps the unfinished meaning-search work available for recovery.", "review_first", ["Leave the Brain alone; it catches up fastest when nothing else is running.", "Check later with brain health."], "The pending count stays unchanged across two later health checks."),
  entry("INGEST_FAILED", "This source refresh is incomplete", "At least one item in the source could not finish ingestion.", "The source cursor stays behind the failed item so a retry can resume without hiding the gap.", "safe_now", ["Review the named failed item or source stage.", "Retry the same ingest command; completed items are designed to be recognized rather than duplicated."], "The same item fails twice or the failed item cannot be opened locally."),
  entry("INPUT_REFUSED", "The Brain chose not to accept this input", "A safety or quality rule found content that should be reviewed before ingestion.", "The item was kept out of the searchable corpus.", "review_first", ["Review the stated safety or quality reason.", "Use a cleaned or intentionally approved source, then preview the ingest again."], "The refusal reason does not match the file being reviewed."),
  entry("INTERNAL_ERROR", "The installer hit an unexpected problem", "The installer encountered a condition that does not yet have a specific recovery message.", "Commands are designed so the same operation can resume or adopt work already completed.", "safe_now", ["Retry the same command once.", "If it repeats, preview the private issue note and share that reviewed record with the technician."], "The problem repeats, or the Brain's current state is uncertain."),
  entry("MIGRATION_FAILED", "The database update paused", "A schema update could not complete or verify its next safe boundary.", "Upgrade state records preserve the last confirmed migration step.", "safe_now", ["Run brain doctor with the same manifest.", "Use the repair command it recommends, then retry the update."], "Doctor reports checksum drift, an incompatible column, or no reviewed repair path."),
  entry("MIGRATION_STILL_APPLYING", "Cloudflare is still applying a database change", "A large database change did not finish within this command's bounded wait.", "Nothing was lost, nothing needs undoing, and the next update checks completed columns before continuing.", "safe_after_step", ["Wait about 10 minutes.", "Run brain update once more; it checks completed columns first and continues."], "The same database change is still applying after the next update attempt."),
  entry("OAUTH_SIGN_IN_TIMEOUT", "The provider sign-in timed out", "The browser sign-in did not finish before its time limit.", "Nothing changed in your Brain and no new connection was saved.", "safe_now", ["Run the same command again.", "Complete sign-in in the provider browser window before its time limit."], "Sign-in times out again after completing the provider screen."),
  entry("NETWORK_UNREACHABLE", "The service could not be reached", "The computer lost a usable route to the local or provider service before the request completed.", "The command stopped with its resumable state intact.", "safe_now", ["Confirm the internet connection and that any VPN or security filter allows the provider.", "Retry the same command."], "Other websites work but this service remains unreachable."),
  entry("PDF_PROCESS_FAILED", "This PDF needs another reading path", "The PDF processor could not produce usable text from the file.", "The document was not presented as a successful clean extraction.", "review_first", ["Open the PDF and check whether its pages contain selectable text.", "For scanned pages, enable the reviewed OCR path or provide a clearer export, then retry."], "A normal text PDF fails, or OCR also fails."),
  entry("PDF_PROCESS_TIMEOUT", "This PDF took too long to read", "PDF processing reached its time limit before a safe result was ready.", "The ingest remains incomplete and can be resumed.", "safe_after_step", ["Try a smaller or split copy of the PDF.", "If it is scanned, use the reviewed OCR path and retry."], "A modest, readable PDF repeatedly reaches the time limit."),
  entry("RATE_LIMITED", "The provider asked us to slow down", "A provider temporarily limited the number of requests.", "Progress already confirmed stays recorded and the remaining work can resume.", "safe_now", ["Wait a few minutes.", "Retry the same command; use the existing cursor or queue rather than resetting the source."], "The limit returns after a longer pause or during very small requests."),
  entry("REMOTE_NOT_FOUND", "The expected service or item was not found", "A provider returned a not-found response for a route, resource, or item the Brain expected.", "The installer did not guess at a replacement resource.", "safe_after_step", ["Confirm the final Brain hostname and the named provider resource.", "For a fresh deployment, allow a short propagation window and retry health."], "The dashboard shows the exact resource but the Brain still cannot find it."),
  entry("REMOTE_PERMISSION_DENIED", "This account does not currently allow the step", "The signed-in account or token lacks access to the requested resource or action.", "The operation stopped instead of switching accounts or broadening access silently.", "safe_after_step", ["Confirm the owner is signed into the intended account.", "Review the least-privilege permissions for this connector, update them in the provider, and retry."], "The intended account and listed permissions are already confirmed."),
  entry("REMOTE_UNAVAILABLE", "The provider is temporarily unavailable", "The remote service answered, but it could not serve this operation right now.", "The Brain keeps the section explicitly unavailable and preserves resume state.", "safe_now", ["Wait briefly and retry the same command.", "Check the provider status page if the same response continues."], "The provider reports healthy service while this code persists."),
  entry("SAFETY_REVIEW_REQUIRED", "A larger change is ready for review", "The requested operation crossed a deletion, scope, or integrity guard that benefits from a human check.", "Nothing beyond the reviewed safety boundary was applied.", "review_first", ["Read the preview and confirm the source, count, and scope are expected.", "Ask the technician to review the plan before using the exact approval step shown by the installer."], "Any item, count, source, or scope in the preview is surprising."),
  entry("SCHEDULE_INSTALL_FAILED", "Automatic refresh was not installed", "The operating system did not confirm the new background schedule.", "Existing source data and any previous schedule remain visible for review.", "safe_after_step", ["Run brain schedule to inspect the current state.", "Resolve the named operating-system permission or path issue, then run the install step again."], "The scheduler reports two copies or an unfamiliar program path."),
  entry("SCHEDULE_RUN_FAILED", "An automatic refresh did not finish", "A scheduled connector run stopped before recording a complete refresh.", "The connector retains its prior cursor so the next run can resume.", "safe_now", ["Run the same ingest command once in the terminal to see the guided message.", "After it succeeds, inspect brain sources to confirm freshness."], "The manual run succeeds but the scheduled run continues to fail."),
  entry("UPGRADE_FAILED", "The update stopped before its last check", "One update stage did not reach its verified completion point.", "Nothing was lost. Your Brain either remains available normally or can still answer questions while document loading is paused.", "safe_now", ["Run brain update once more; it picks up where it stopped.", "If it stops again at the same step, run brain support --preview and send us that note."], "The same step stops again after one safe retry."),
  entry("UPDATE_BRAIN_BUSY", "The Brain was too busy to begin the update", "The readiness check could not get a complete answer before the update began.", "Nothing was changed, and you can keep using your Brain.", "safe_now", ["Wait a few minutes, then run brain update again.", "If the same check is still busy, run brain health once and keep its output for support."], "The readiness check stays busy after one retry."),
  entry("UPDATE_WAITING_FOR_INDEXING", "The Brain is still indexing", "Recent items are still being prepared so they can be found by meaning.", "The update did not begin, so nothing was changed and the Brain remains usable.", "safe_now", ["Keep using your Brain while indexing finishes.", "Run brain update again later."], "Brain health shows no indexing progress across two checks."),
  entry("VECTOR_DRAIN_FAILED", "Search is still catching up", "New documents are saved and can already be found by their exact words.", "The durable queue keeps the unfinished meaning-search work available for recovery.", "review_first", ["Leave the Brain alone; it catches up fastest when nothing else is running.", "Check later with brain health. If brain health says the Brain is paused for an update, run brain update once more."], "The pending count stays unchanged across two later health checks."),
  entry("WINDOWS_DPAPI_LAUNCH_REFUSED", "Windows briefly blocked a helper", "Windows briefly blocked the local helper that protects this computer's saved keys.", "Your keys are safe and nothing changed.", "safe_now", ["Run the same command again; it usually works the second time.", "If it repeats, open Windows Security and review the named app-control message."], "The same helper is blocked on the second run."),
  ...OPERATIONAL_STATUS_CODES.map((code) => entry(
    code,
    code.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
    "A local setup check stopped before it could confirm the next safe step.",
    "The command kept its current state and left the unfinished step explicit.",
    "safe_after_step",
    ["Read the explanation printed beside this code.", "Complete that one local step, then run the same command again."],
    "The same code returns after its named local step is complete.",
  )),
];

export const SUPPORT_RECOVERY_CATALOG = Object.freeze(Object.fromEntries(CATALOG.map((item) => [item.code, item])));

if (CATALOG.length !== SUPPORT_ERROR_CODES.length ||
    SUPPORT_ERROR_CODES.some((code) => !SUPPORT_RECOVERY_CATALOG[code]) ||
    CATALOG.some((item) => !RETRY_STATES.has(item.retry))) {
  throw new Error("support recovery catalog does not match the support issue schema");
}

// Keep Windows recovery routes out of the existing macOS/Linux explanations.
const WINDOWS_RECOVERY = Object.freeze(Object.fromEntries([
  entry("AUTH_REQUIRED", "A sign-in or credential is still needed", "This step reached a protected service without a usable authorization.", "The installer paused before relying on missing access.", "safe_after_step", ["Return to the matching technician step for Cloudflare, Google, Zoom, or IMAP.", "For Cloudflare on Windows, approve browser sign-in with brain update <manifest> --adopt-cloudflare-profile in a visible PowerShell window. Windows has no saved Cloudflare-token recovery or supported hidden token entry in this release.", "Enter sensitive values only in a provider page or a supported protected entry flow."], "It is unclear which account or provider step is missing."),
  entry("CLOUDFLARE_KEYRING_UNAVAILABLE", "Cloudflare protected storage needs attention", "The keyring step stopped before browser sign-in. Reasons: binding_missing means the Windows binding is missing or cannot load; npx_unavailable means the Node.js launcher is unavailable; timeout means the step exceeded its time limit; other means a different keyring failure.", "No new browser profile was recorded and encrypted storage remains required.", "safe_after_step", [WINDOWS_KEYRING_RECOVERY, "For npx_unavailable, restore the supported Node.js installation first. For timeout, check npm registry access."], "The visible command still fails, or Windows blocks the native binding."),
].map((item) => [item.code, item])));

export function supportRecovery(code, { platformName = process.platform } = {}) {
  const normalized = String(code || "").trim().toUpperCase();
  const result = SUPPORT_RECOVERY_CATALOG[normalized];
  if (!result) {
    const error = new Error(`unknown issue code ${normalized || "(empty)"}`);
    error.code = "CONFIG_INVALID";
    throw error;
  }
  return platformName === "win32" ? (WINDOWS_RECOVERY[normalized] ?? result) : result;
}

export function renderSupportRecovery(recovery) {
  const retryLabel = {
    safe_now: "Yes. The same command is designed to resume safely.",
    safe_after_step: "Yes, after the step below is complete.",
    review_first: "Pause for the short review below first.",
  }[recovery.retry];
  return [
    "",
    `${recovery.code} · ${recovery.title}`,
    "",
    `What happened: ${recovery.what_happened}`,
    `What stayed protected: ${recovery.protection}`,
    `Safe to retry: ${retryLabel}`,
    "",
    "Next step:",
    ...recovery.next_steps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    `A technician can help when: ${recovery.technician_when}`,
    "",
  ].join("\n");
}
