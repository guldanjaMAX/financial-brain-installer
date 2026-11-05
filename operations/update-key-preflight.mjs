import { CloudflareOAuthSessionError } from "./cloudflare-oauth-session.mjs";
import { ANTHROPIC_SECRET_NAME, answerSetupOf } from "./answer-setup.mjs";

const DASHBOARD_NEXT_STEP = "In Cloudflare, open your Brain's Worker, then Settings, Variables and Secrets, Add. Choose Secret, name it ANTHROPIC_API_KEY, paste the key in the masked field and save. Then rerun brain update.";

/** Read names from the exact manifest target, never values or a name search. */
export async function readUpdateAnswerKeySecretNames(manifest, { cf } = {}) {
  const accountId = manifest.infrastructure?.cloudflare?.account_id;
  const scriptName = manifest.brain?.worker_name || `${manifest.client?.slug || "client"}-brain`;
  if (typeof accountId !== "string" || !accountId || accountId.startsWith("REQUIRED")) {
    throw new TypeError("the update has no exact account binding");
  }
  const inventory = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`);
  if (!Array.isArray(inventory) || inventory.some(entry =>
    !entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name)) {
    throw new TypeError("the Worker secret-name inventory is unreadable");
  }
  return inventory.map(entry => entry.name);
}

/** The caller supplies the resulting model setup and already approved access. */
export async function checkUpdateAnswerKey(manifest, { workerState, readSecretNames, preserveCredentialFailure = false } = {}) {
  if (answerSetupOf(manifest) === "built-in") return { status: "not_required" };
  let status = "missing", source = "worker_key_state";
  // Older Workers have no typed key state. Silence cannot prove a key exists.
  if (workerState?.anthropic_key_missing !== true) {
    source = "worker_secret_names";
    try {
      const names = await readSecretNames();
      if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !name)) {
        throw new TypeError("invalid Worker secret names");
      }
      status = names.includes(ANTHROPIC_SECRET_NAME) ? "present" : "missing";
    } catch (error) {
      if (preserveCredentialFailure && (error instanceof CloudflareOAuthSessionError || error?.namedProfileSessionRejected === true)) throw error;
      status = "unverified";
    }
  }
  if (status === "present") return { status, source };
  return {
    status, source,
    blocking_prerequisite: status === "missing"
      ? "This update needs the Worker's Anthropic key, but that key is missing. No Brain update was started."
      : "This update needs the Worker's Anthropic key, but its presence could not be checked. No Brain update was started.",
    // The legacy saved model can block connect. Dashboard entry does not use
    // that guard or the local update recovery fence, and keeps entry masked.
    next_step: status === "missing" ? DASHBOARD_NEXT_STEP
      : "For a saved profile, run brain verify <manifest> separately in an interactive terminal and approve sign-in repair. For an older install, approve brain update <manifest> --adopt-cloudflare-profile. Normal update checks the key after authentication; preview cannot acquire or refresh saved credentials.",
  };
}
