import { REVIEWED_WRANGLER_SPEC } from "./wrangler-runtime-contract.mjs";

export const WINDOWS_KEYRING_ENABLE_COMMAND =
  `$env:CLOUDFLARE_AUTH_USE_KEYRING='true'; & npx.cmd --yes ${REVIEWED_WRANGLER_SPEC} auth keyring enable --env-file=NUL`;
export const WINDOWS_KEYRING_ENV_CLEANUP = "Remove-Item Env:CLOUDFLARE_AUTH_USE_KEYRING";
export const WINDOWS_KEYRING_RECOVERY =
  "In a visible PowerShell window, as the same Windows user, run:\n" +
  `  ${WINDOWS_KEYRING_ENABLE_COMMAND}\n` +
  `Then run ${WINDOWS_KEYRING_ENV_CLEANUP} and retry the same Brain command. ` +
  "Wrangler installs its encrypted-storage binding once for this Windows user.";

const REASONS = Object.freeze({
  binding_missing: "Wrangler's Windows keyring binding is missing or cannot load.",
  npx_unavailable: "The npx launcher is unavailable; the supported Node.js installation may need repair.",
  timeout: "The keyring step timed out; npm registry access may be unavailable.",
  other: "Wrangler could not enable encrypted credential storage.",
});

export function cloudflareKeyringFailureMessage(reason, platformName, { ownerConsole = false } = {}) {
  if (platformName !== "win32") return "Wrangler could not enable encrypted OS-keyring credential storage";
  const safeReason = Object.hasOwn(REASONS, reason) ? reason : "other";
  // Inherited output is already visible, but there are no captured bytes to
  // classify an ordinary Wrangler failure. Piped output was wiped, so only a
  // subsequent owner-visible run can provide that reason for review.
  const next = safeReason === "other" && ownerConsole
    ? "The console output above shows Wrangler's reason. Review that output with a technician before retrying."
    : WINDOWS_KEYRING_RECOVERY + " If that visible run still fails, ask a technician to review its output.";
  return `Cloudflare sign-in stopped before the browser opened. Keyring reason: ${safeReason}. ` +
    `${REASONS[safeReason]} ${next}`;
}
