import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// No artifact has been adopted. Only a separately reviewed signing receipt can
// populate these pins. Never compile, download, or accept an adjacent checksum.
export const QBD_HELPERS = Object.freeze({
  x86: Object.freeze({ path: fileURLToPath(new URL('./quickbooks-desktop-helper.exe', import.meta.url)), sha256: null }),
  x64: null,
});
export const QBD_ENVIRONMENT = Object.freeze([
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'PATH',
]);
export function qbdEnvironment(environment = {}) {
  const result = {};
  for (const name of QBD_ENVIRONMENT) {
    const match = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
    if (match && typeof environment[match] === 'string') result[name] = environment[match];
  }
  return result;
}
const unavailable = () => ({ ok: false, code: 'QB_HELPER_UNAVAILABLE' });
export function inspectQuickBooksDesktopHelper(artifact, fs = { lstatSync, readFileSync, realpathSync }) {
  try {
    if (!artifact || !isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) return unavailable();
    const identity = fs.lstatSync(artifact.path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 ||
        identity.size < 1 || identity.size > 4 * 1024 * 1024 ||
        resolve(fs.realpathSync(artifact.path)).toLowerCase() !== resolve(artifact.path).toLowerCase()) return unavailable();
    const bytes = fs.readFileSync(artifact.path);
    let sha256;
    try { sha256 = createHash('sha256').update(bytes).digest('hex'); } finally { bytes.fill(0); }
    if (sha256 !== artifact.sha256) return unavailable();
    return { ok: true, path: artifact.path, sha256, identity };
  } catch { return unavailable(); }
}
export function sameQbdIdentity(a, b) {
  return Boolean(a?.ok && b?.ok && a.path === b.path && a.sha256 === b.sha256 &&
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a.identity[key] === b.identity[key]));
}

// The program is fixed. File paths travel as stdin, never as PowerShell code.
// PowerShell emits only a decision; native output and errors never escape.
export function verifyQbdAuthenticode(path, signer, { environment = {}, run = spawnSync } = {}) {
  try {
    const env = qbdEnvironment(environment);
    if (!win32.isAbsolute(env.SystemRoot || '') || !['helper', 'processor'].includes(signer)) return false;
    const organization = signer === 'helper' ? 'Financial Brain LLC' : 'Intuit Inc\\.?';
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '$p = [Console]::In.ReadToEnd()',
      '$s = Get-AuthenticodeSignature -LiteralPath $p',
      "if ($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate) { exit 1 }",
      '$subject = $s.SignerCertificate.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)',
      `if ($subject -cnotmatch '(?m)^O=${organization}\\r?$') { exit 1 }`,
      'exit 0',
    ].join('; ');
    const result = run(win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        env, input: path, shell: false, windowsHide: true, encoding: null,
        stdio: ['pipe', 'pipe', 'ignore'], timeout: 120_000, maxBuffer: 1024,
      });
    const valid = result?.status === 0 && !result.error && !result.signal;
    if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
    if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
    return valid;
  } catch { return false; }
}
export function verifyQuickBooksDesktopHelper(artifact, options = {}) {
  const before = inspectQuickBooksDesktopHelper(artifact, options.fs);
  if (!before.ok) return before;
  if (!verifyQbdAuthenticode(before.path, 'helper', options)) return unavailable();
  const after = inspectQuickBooksDesktopHelper(artifact, options.fs);
  return sameQbdIdentity(before, after) ? after : unavailable();
}
