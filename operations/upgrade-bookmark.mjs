import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { windowsFileChildEnvironment } from "./current-user-file.mjs";

// Modes passed to Node do not establish a Windows DACL. Replace inherited and
// explicit grants on our own receipt paths, then independently read the DACL.
// Paths travel on stdin, never inside executable PowerShell source.
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $request.path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      [bool]$item.PSIsContainer -ne [bool]$request.directory) { throw 'unsafe path' }
  $acl = Get-Acl -LiteralPath $request.path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'wrong owner' }
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($request.directory) { $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
  if (-not $request.verifyOnly) {
    if ($request.directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $request.path -AclObject $acl
  }
  $acl = Get-Acl -LiteralPath $request.path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or
      $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
      $rules.Count -ne 1) { throw 'unverified ACL' }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or
      $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or
      $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw 'unverified grant' }
  [Console]::Out.Write('private')
} catch { exit 1 }
`;

export function secureWindowsUpgradeBookmarkPath(path, {
  directory = false, verifyOnly = false, run = spawnSync, environment = process.env,
} = {}) {
  const env = windowsFileChildEnvironment(environment);
  if (!win32.isAbsolute(env.SystemRoot || "")) throw new Error("recovery receipt Windows ACL runtime unavailable");
  let result;
  try {
    result = run(win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64")], {
        input: JSON.stringify({ path, directory, verifyOnly }), encoding: null, env,
        shell: false, stdio: ["pipe", "pipe", "pipe"], timeout: 15_000, windowsHide: true,
      });
    if (result?.status !== 0 || result.error || result.signal || String(result.stdout) !== "private") {
      throw new Error("unverified ACL");
    }
  } catch {
    throw new Error("recovery receipt Windows ACL could not be protected and verified");
  } finally {
    if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
    if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
  }
}

/** Keep the pre-change restore point even if deployment kills the process.
 * Local storage also covers legacy databases without upgrade_runs. Every
 * attempt gets its own immutable receipt; a retry never replaces the earlier
 * pre-migration bookmark with a snapshot of a partly migrated database.
 */
export function saveUpgradeBookmark(record, {
  directory = join(homedir(), ".brain", "upgrade-bookmarks"),
  now = () => new Date(),
  io = fs,
  windowsAcl = secureWindowsUpgradeBookmarkPath,
  platform = process.platform,
} = {}) {
  const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const assertDirectory = (path) => {
    const stat = io.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("recovery directory must not use links");
    if (platform !== "win32" &&
        (![0, process.getuid()].includes(stat.uid) ||
         ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000))))) {
      throw new Error("untrusted recovery directory ancestor");
    }
    return stat;
  };
  const syncDirectory = (path) => {
    // Node cannot fsync a directory on Windows. The receipt file itself is
    // flushed everywhere; native Windows power-loss durability is a field gate.
    if (platform === "win32") return;
    const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  const ensureDirectory = (path) => {
    const parent = dirname(path);
    if (parent !== path) ensureDirectory(parent);
    try {
      assertDirectory(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      io.mkdirSync(path, { mode: 0o700 });
      syncDirectory(parent);
      assertDirectory(path);
    }
  };
  for (const value of [record.account_id, record.database_id, record.bookmark, record.from_version, record.to_version]) {
    if (typeof value !== "string" || !value.length || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("invalid recovery bookmark identity");
    }
  }
  const bytes = JSON.stringify({ schema_version: 1, captured_at: now().toISOString(), ...record }) + "\n";
  directory = resolve(directory);
  ensureDirectory(directory);
  const directoryStat = assertDirectory(directory);
  // Native casing can differ on case-insensitive volumes. Check the identity
  // of both spellings after checking every component for actual links.
  const canonical = io.realpathSync.native(directory);
  if (!sameFile(directoryStat, assertDirectory(canonical))) throw new Error("recovery directory identity changed");
  directory = canonical;
  if (platform !== "win32" && ((directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== process.getuid())) {
    throw new Error("recovery directory must be private and owned by this user");
  }
  if (platform === "win32") windowsAcl(directory, { directory: true });
  const path = join(directory, `${randomUUID()}.json`);
  const fd = io.openSync(path, "wx", 0o600);
  let writtenStat;
  const assertReceipt = (stat) => {
    if (!stat.isFile() || stat.nlink !== 1 ||
        (platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw new Error("recovery bookmark must be a private regular file");
    }
  };
  // Leave incomplete receipts in place for inspection; never erase recovery
  // evidence when a write, flush, or readback fails.
  try {
    writtenStat = io.fstatSync(fd);
    assertReceipt(writtenStat);
    if (platform === "win32") windowsAcl(path, { directory: false });
    if (!sameFile(writtenStat, io.lstatSync(path))) throw new Error("recovery bookmark identity changed");
    io.writeFileSync(fd, bytes);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  syncDirectory(directory);
  const readFd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = io.fstatSync(readFd);
    assertReceipt(stat);
    if (!sameFile(writtenStat, stat) || !sameFile(stat, io.lstatSync(path))) throw new Error("recovery bookmark identity changed");
    const readback = io.readFileSync(readFd);
    if (stat.size !== Buffer.byteLength(bytes) ||
        !Buffer.isBuffer(readback) || !Buffer.from(bytes).equals(readback)) throw new Error("recovery bookmark did not read back exactly");
    const after = io.lstatSync(path);
    assertReceipt(after);
    if (!sameFile(stat, after) || !sameFile(directoryStat, assertDirectory(directory))) throw new Error("recovery bookmark identity changed");
    if (platform === "win32") {
      windowsAcl(path, { directory: false, verifyOnly: true });
      windowsAcl(directory, { directory: true, verifyOnly: true });
    }
  } finally { io.closeSync(readFd); }
  return path;
}
