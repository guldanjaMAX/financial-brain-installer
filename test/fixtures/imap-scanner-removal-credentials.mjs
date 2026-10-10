// The scanner fixture starts with a synthetic legacy plaintext record. Keep
// the real Windows migration and readback path, injecting only its native
// DPAPI and ACL operations for this one scratch file.
import assert from "node:assert/strict";
import { realpathSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadTokens as loadRealTokens } from "../../connectors/google-auth.mjs";

export { saveTokens, tokenStorageDescription } from "../../connectors/google-auth.mjs";

const prefix = Buffer.from("IMAP-FIXTURE-ONLY:", "ascii");
const helper = new URL("../../operations/windows-dpapi.ps1", import.meta.url);

export function loadTokens(options) {
  const home = process.env.BRAIN_IMAP_SCANNER_USER_ROOT;
  assert.ok(home && process.env.BRAIN_IMAP_CREDENTIAL_STORE === "file",
    "IMAP credential fixture requires its scratch file store");
  const root = realpathSync(home);
  const path = join(root, ".brain", "imap-credentials.json");
  assert.ok(options?.path === path && realpathSync(path) === path &&
    options.storeEnv === "BRAIN_IMAP_CREDENTIAL_STORE",
  "IMAP credential fixture refused a different store");
  return loadRealTokens({
    ...options,
    username: "fixture-user",
    environment: { SystemRoot: "C:\\Windows" },
    runPowerShell(command, args, childOptions) {
      assert.equal(basename(command), "powershell.exe");
      assert.deepEqual(args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
      assert.equal(args[6], realpathSync(helper));
      assert.equal(args[7], "-Operation");
      assert.equal(args[9], "-ExpectedLength");
      assert.equal(args.length, 11);
      assert.equal(args[10], String(childOptions.input.length));
      assert.equal(childOptions.shell, false);
      assert.equal(childOptions.windowsHide, true);
      const input = childOptions.input;
      assert.ok(Buffer.isBuffer(input), "fixture DPAPI needs a buffer");
      const operation = args[8];
      assert.ok(operation === "protect" || operation === "unprotect", "fixture DPAPI refused an operation");
      if (operation === "unprotect") assert.ok(input.subarray(0, prefix.length).equals(prefix),
        "fixture DPAPI refused bytes outside its synthetic envelope");
      writeSync(2, `TEST_IMAP_DPAPI_REACHED:${operation}\n`);
      return { status: 0, stdout: operation === "protect"
        ? Buffer.concat([prefix, input]) : Buffer.from(input.subarray(prefix.length)), stderr: Buffer.alloc(0) };
    },
    runAcl(command, args, childOptions) {
      assert.equal(command, "C:\\Windows\\System32\\icacls.exe");
      assert.ok(realpathSync(dirname(args[0])) === dirname(path) &&
        /^\.imap-credentials\.json\.[0-9]+\.[a-f0-9]{16}\.(tmp|bak)$/.test(basename(args[0])),
      "IMAP credential ACL fixture refused a different file");
      assert.deepEqual(args.slice(1), ["/inheritance:r", "/grant:r", "fixture-user:F"]);
      assert.equal(childOptions.shell, false);
      assert.equal(childOptions.windowsHide, true);
      writeSync(2, "TEST_IMAP_CREDENTIAL_ACL_REACHED\n");
      return { status: 0 };
    },
  });
}
