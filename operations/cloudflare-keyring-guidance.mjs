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
  npx_unavailable: "The npx launcher is unavailable. Restore the supported Node.js installation and reopen PowerShell.",
  timeout: "The keyring step timed out. Check access to the npm registry before retrying.",
  other: "Wrangler could not enable encrypted credential storage. Review the visible console result with a technician.",
});

export function cloudflareKeyringFailureMessage(reason, platformName) {
  const safeReason = Object.hasOwn(REASONS, reason) ? reason : "other";
  const next = platformName === "win32"
    ? WINDOWS_KEYRING_RECOVERY
    : "Confirm this computer's protected credential store is available and rerun the same command.";
  return `Cloudflare sign-in stopped before the browser opened. Keyring reason: ${safeReason}. ` +
    `${REASONS[safeReason]} ${next}`;
}
