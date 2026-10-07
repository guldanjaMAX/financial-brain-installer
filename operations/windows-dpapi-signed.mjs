/** The release pins the signed image, not an editable adjacent checksum. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_DPAPI_SIGNED_PATH = fileURLToPath(new URL("./windows-dpapi-helper.exe", import.meta.url));
// Reviewed artifact: windows-dpapi-helper-signed, CI run 37551020332.
export const WINDOWS_DPAPI_SIGNED_SHA256 = "ca94c72a0ca4562629224e9cdb51d02fa2fe132b315e98b12cdbec8128d8f859";

export function inspectWindowsDpapiSignedHelper(path = WINDOWS_DPAPI_SIGNED_PATH) {
  if (!isAbsolute(path) || basename(path) !== "windows-dpapi-helper.exe") {
    throw new Error("Invalid packaged DPAPI helper path");
  }
  let identity;
  try { identity = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ reason: "missing" });
    throw new Error("Packaged DPAPI helper is unreadable");
  }
  // Invalid file identities are not permission to compile or follow a link.
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
      identity.size < 1 || identity.size > 4 * 1024 * 1024 ||
      resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) {
    throw new Error("Invalid packaged DPAPI helper identity");
  }
  const bytes = readFileSync(path);
  try {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== WINDOWS_DPAPI_SIGNED_SHA256) return Object.freeze({ reason: "hash_mismatch" });
    return Object.freeze({ path: realpathSync.native(path), identity, sha256 });
  } finally { bytes.fill(0); }
}

/** Native release proof. No credential inputs, inherited desktop environment,
 * or raw certificate/PowerShell output cross this boundary. */
export function verifyWindowsDpapiSignature({
  platform = process.platform,
  environment = process.env,
  run = spawnSync,
} = {}) {
  if (platform !== "win32") throw new Error("Authenticode verification requires Windows");
  const helper = inspectWindowsDpapiSignedHelper();
  if (helper.reason) throw new Error("Signed DPAPI release image is unavailable");
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || environment.WINDIR;
  if (!isAbsolute(systemRoot || "")) throw new Error("Windows signature runtime is unavailable");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$s = Get-AuthenticodeSignature -LiteralPath $env:BRAIN_DPAPI_SIGNATURE_FILE",
    "if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate) { exit 1 }",
    // Match the organization RDN exactly, not CN or a substring of another O.
    "$subject = $s.SignerCertificate.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)",
    "if ($subject -cnotmatch '(?m)^O=Financial Brain LLC\\r?$') { exit 1 }",
    "exit 0",
  ].join("; ");
  const result = run(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: { SystemRoot: systemRoot, BRAIN_DPAPI_SIGNATURE_FILE: helper.path },
      shell: false, stdio: ["ignore", "pipe", "pipe"], encoding: null,
      timeout: 30_000, windowsHide: true,
    });
  const valid = result?.status === 0 && !result?.error;
  if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
  if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
  if (!valid) throw new Error("Signed DPAPI Authenticode verification failed");
  // Bind verification to the same pinned bytes after the native check too.
  const after = inspectWindowsDpapiSignedHelper();
  if (after.reason || after.identity.dev !== helper.identity.dev || after.identity.ino !== helper.identity.ino) {
    throw new Error("Signed DPAPI image changed during verification");
  }
  return Object.freeze({ verified: true, sha256: helper.sha256 });
}
