/** Console-only child: no manifest, account secret, token capture, or update. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCloudflareOAuthProfile } from "./cloudflare-oauth-session.mjs";
import { WINDOWS_SIGNIN_EXIT } from "./windows-update-signin.mjs";

const FAILURE_STATUS = Object.freeze({
  CLOUDFLARE_KEYRING_UNAVAILABLE: WINDOWS_SIGNIN_EXIT.keyring,
  CLOUDFLARE_OAUTH_WORKDIR_UNWRITABLE: WINDOWS_SIGNIN_EXIT.workdir,
  CLOUDFLARE_OAUTH_REAUTH_REQUIRED: WINDOWS_SIGNIN_EXIT.unfinished,
});

export function runWindowsCloudflareSignIn(args, {
  authorize = createCloudflareOAuthProfile,
  platformName = process.platform, input = process.stdin, output = process.stdout,
  environment = process.env, workingDirectory = process.cwd(),
} = {}) {
  if (platformName !== "win32" || !Array.isArray(args) || args.length !== 1 ||
      !/^financial-brain-[a-f0-9]{24}$/u.test(args[0])) return WINDOWS_SIGNIN_EXIT.unavailable;
  if (!input.isTTY || !output.isTTY) return WINDOWS_SIGNIN_EXIT.noConsole;
  output.write("Sign in to Cloudflare in the browser. Your update will continue in the assistant conversation.\n");
  try {
    authorize({ profile: args[0], platformName, input, output, environment,
      workingDirectory, windowsHide: false });
    return 0;
  } catch (error) {
    // Only a closed exit-code vocabulary crosses the console boundary. Never
    // echo exceptions, OAuth links, or Wrangler output into the parent process.
    const status = Object.hasOwn(FAILURE_STATUS, error?.code)
      ? FAILURE_STATUS[error.code] : WINDOWS_SIGNIN_EXIT.unavailable;
    output.write("Sign-in stopped. Click back into the assistant conversation for help with this update.\n");
    return status;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.title = "Financial Brain sign-in";
  process.exitCode = runWindowsCloudflareSignIn(process.argv.slice(2));
}
