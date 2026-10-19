import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { saveUpgradeBookmark, secureWindowsUpgradeBookmarkPath, WINDOWS_UPGRADE_BOOKMARK_ACL_TIMEOUT_MS } from "../operations/upgrade-bookmark.mjs";
import { windowsFileChildEnvironment } from "../operations/current-user-file.mjs";

// Native tests touch only synthetic receipt paths. They never invoke a
// credential helper, account endpoint, scheduler, or the installer CLI.
const NATIVE_ACL_TIMEOUT_MS = WINDOWS_UPGRADE_BOOKMARK_ACL_TIMEOUT_MS + 30_000;
// The elevated-owner case deliberately performs multiple independent native
// observations as well as product calls. Its outer limit must cover all of them.
const NATIVE_TEST_TIMEOUT_MS = 20 * NATIVE_ACL_TIMEOUT_MS;

function acl(path, broaden = false, administratorOwner = false, { run = spawnSync, environment = process.env, reprotect = false } = {}) {
  const env = windowsFileChildEnvironment(environment);
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
      $request = $reader.ReadToEnd() | ConvertFrom-Json
      $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
      $sid = $identity.User
      $acl = Get-Acl -LiteralPath $request.path
      if ($request.administratorOwner) {
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
          [Console]::Out.Write('{"elevated":false}')
          exit 0
        }
        $owner = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
        $acl.SetOwner($owner)
        (Get-Item -LiteralPath $request.path -Force).SetAccessControl($acl)
        $acl = Get-Acl -LiteralPath $request.path
        [Console]::Out.Write((@{ elevated = $true; administratorOwned = ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $owner.Value) } | ConvertTo-Json -Compress))
        exit 0
      }
      if ($request.broaden) {
        $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
        $flags = [System.Security.AccessControl.InheritanceFlags]::None
        if ((Get-Item -LiteralPath $request.path -Force).PSIsContainer) {
          $flags = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        }
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', $flags, 'None', 'Allow')))
        (Get-Item -LiteralPath $request.path -Force).SetAccessControl($acl)
        $acl = Get-Acl -LiteralPath $request.path
      }
      if ($request.reprotect) {
        $item = Get-Item -LiteralPath $request.path -Force
        $flags = [System.Security.AccessControl.InheritanceFlags]::None
        if ($item.PSIsContainer) {
          $acl = New-Object System.Security.AccessControl.DirectorySecurity
          $flags = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else { $acl = New-Object System.Security.AccessControl.FileSecurity }
        $acl.SetOwner($sid)
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $flags, 'None', 'Allow')))
        $item.SetAccessControl($acl)
        $acl = Get-Acl -LiteralPath $request.path
      }
      $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
      $broad = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid.Value }).Count
      $flags = [System.Security.AccessControl.InheritanceFlags]::None
      if ((Get-Item -LiteralPath $request.path -Force).PSIsContainer) {
        $flags = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      }
      $exact = $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and
        -not $rules[0].IsInherited -and $rules[0].AccessControlType -eq 'Allow' -and
        $rules[0].FileSystemRights -eq 'FullControl' -and $rules[0].InheritanceFlags -eq $flags -and
        $rules[0].PropagationFlags -eq 'None'
      [Console]::Out.Write((@{ broad = $broad; protected = $acl.AreAccessRulesProtected; owner = ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value); rules = $rules.Count; exact = $exact } | ConvertTo-Json -Compress))
    } catch { exit 1 }
  `;
  const result = run(win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      input: JSON.stringify({ path, broaden, administratorOwner, reprotect }), encoding: "utf8", env, shell: false,
      timeout: NATIVE_ACL_TIMEOUT_MS, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  assert.equal(result.status, 0, "native fixture ACL operation completed");
  return JSON.parse(result.stdout);
}

const record = {
  account_id: "fixture-account", database_id: "fixture-db", bookmark: "fixture-before-update",
  from_version: "0.4.1", to_version: "0.4.11", manifest_sha256: "0".repeat(64),
};
const now = () => new Date("2026-10-10T12:00:00.000Z");
const privateAcl = { broad: 0, protected: true, owner: true, rules: 1, exact: true };

test("Windows ACL boundary: already-private proof exits before the only write", () => {
  let calls = 0;
  secureWindowsUpgradeBookmarkPath("C:\\fixture\\private-bookmarks", {
    directory: true, environment: { SystemRoot: "C:\\Windows" },
    run(_command, args, options) {
      calls++;
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.deepEqual(JSON.parse(options.input), {
        path: "C:\\fixture\\private-bookmarks", directory: true, verifyOnly: false,
      });
      // A portable stub can inspect the real child program but cannot execute
      // .NET ACLs. The native no-write trap below proves this branch on Windows.
      const earlyExit = /if \(Test-PrivateAcl \$acl\) \{\s*\[Console\]::Out.Write\('private'\)\s*exit 0\s*\}/;
      assert.match(script, earlyExit);
      assert.ok(script.indexOf("Get-Acl") < script.search(earlyExit), "the ACL read precedes the no-write decision");
      assert.ok(script.search(earlyExit) < script.indexOf(".SetAccessControl("), "private proof exits before mutation");
      assert.equal((script.match(/\.SetAccessControl\(/g) || []).length, 1);
      assert.doesNotMatch(script, /Set-Acl|SetAuditRule|SetGroup/);
      assert.match(script, /if \(-not \(Test-PrivateAcl \$acl\)\)/, "readback uses the same exact predicate");
      for (const invariant of ["AreAccessRulesProtected", "GetOwner", "GetAccessRules", "$rules.Count", "IdentityReference.Value",
        "IsInherited", "AccessControlType", "FileSystemRights", "InheritanceFlags", "PropagationFlags"]) {
        assert.ok(script.slice(script.indexOf("function Test-PrivateAcl"), script.indexOf("try {")).includes(invariant), invariant);
      }
      return { status: 0, stdout: Buffer.from("private"), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(calls, 1, "private proof needs only one child and no repair invocation");
});

for (const reason of ["set-failed", "verify-failed", "wrong-owner", "unsafe-path"]) {
  test(`Windows ACL boundary: ${reason} is reported without native details`, () => {
    let calls = 0;
    const path = "C:\\fixture\\private-profile\\receipt.json";
    const stdout = Buffer.from(path);
    const stderr = Buffer.from(reason);
    assert.throws(() => secureWindowsUpgradeBookmarkPath(path, {
      environment: { SystemRoot: "C:\\Windows" },
      run(_command, args) {
        calls++;
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.match(script, /\[Console\]::Error.Write\(\$reason\)/);
        assert.doesNotMatch(script, /Write-Error|\[Console\]::Error.Write\([^)]*request/);
        return { status: 1, stdout, stderr };
      },
    }), { message: `recovery receipt Windows ACL could not be protected and verified (${reason})` });
    assert.equal(calls, 1, "the native refusal decision was reached");
    assert.ok(stdout.every((byte) => byte === 0) && stderr.every((byte) => byte === 0));
    secureWindowsUpgradeBookmarkPath(path, { environment: { SystemRoot: "C:\\Windows" }, run() {
      calls++;
      return { status: 0, stdout: Buffer.from("private"), stderr: Buffer.alloc(0) };
    } });
    assert.equal(calls, 2, "private ACL proof is the green control");
  });
}

test("Windows ACL boundary: arbitrary stderr and thrown native errors never echo a path", () => {
  const path = "C:\\fixture\\private-profile\\receipt.json";
  for (const stderr of [path, `set-failed\n${path}`, `unsafe-path ${path}`, "unknown-reason"]) {
    let calls = 0;
    assert.throws(() => secureWindowsUpgradeBookmarkPath(path, {
      environment: { SystemRoot: "C:\\Windows" }, run() {
        calls++;
        return { status: 1, stdout: Buffer.from(path), stderr: Buffer.from(stderr) };
      },
    }), { message: "recovery receipt Windows ACL could not be protected and verified" });
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.throws(() => secureWindowsUpgradeBookmarkPath(path, {
    environment: { SystemRoot: "C:\\Windows" }, run() { calls++; throw new Error(path); },
  }), { message: "recovery receipt Windows ACL could not be protected and verified" });
  assert.equal(calls, 1);
  secureWindowsUpgradeBookmarkPath(path, { environment: { SystemRoot: "C:\\Windows" }, run() {
    calls++;
    return { status: 0, stdout: Buffer.from("private"), stderr: Buffer.alloc(0) };
  } });
  assert.equal(calls, 2, "private ACL proof is the green control");
});

test("CI native Windows: fresh, second, and manually reprotected third bookmark saves", {
  timeout: NATIVE_TEST_TIMEOUT_MS,
  skip: process.platform !== "win32" ? "requires native Windows PowerShell" : false,
}, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-resave-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "bookmarks");
  const first = saveUpgradeBookmark(record, { directory, now });
  const firstBytes = fs.readFileSync(first);
  assert.deepEqual(acl(directory), privateAcl, "fresh directory control is exactly private");
  assert.deepEqual(acl(first), privateAcl);
  let privateChecks = 0;
  const noWrite = (target, options) => secureWindowsUpgradeBookmarkPath(target, { ...options,
    run(command, args, options) {
      privateChecks++;
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.equal((script.match(/\$item\.SetAccessControl\(\$acl\)/g) || []).length, 1, "write trap is armed");
      const trapped = script.replace("$item.SetAccessControl($acl)", "throw 'unexpected ACL write'");
      return spawnSync(command, [...args.slice(0, -1), Buffer.from(trapped, "utf16le").toString("base64")], options);
    },
  });
  const windowsAcl = (target, options) => options.directory || options.verifyOnly
    ? noWrite(target, options) : secureWindowsUpgradeBookmarkPath(target, options);
  const second = saveUpgradeBookmark({ ...record, bookmark: "fixture-second-update" }, { directory, now, windowsAcl });
  assert.notEqual(second, first, "second update keeps a distinct receipt");
  const secondBytes = fs.readFileSync(second);
  assert.equal(JSON.parse(secondBytes).bookmark, "fixture-second-update");
  noWrite(second, { directory: false });
  assert.deepEqual(acl(directory, false, false, { reprotect: true }), privateAcl, "manual protection decision read back");
  const third = saveUpgradeBookmark({ ...record, bookmark: "fixture-third-update" }, { directory, now, windowsAcl });
  assert.equal(new Set([first, second, third]).size, 3);
  assert.equal(fs.readdirSync(directory).length, 3);
  assert.equal(privateChecks, 7, "second and third saves and an existing file took the no-write branch");
  assert.equal(JSON.parse(fs.readFileSync(third)).bookmark, "fixture-third-update");
  assert.deepEqual(fs.readFileSync(first), firstBytes);
  assert.deepEqual(fs.readFileSync(second), secondBytes);
  for (const path of [directory, first, second, third]) assert.deepEqual(acl(path), privateAcl);
});

for (const directory of [true, false]) {
  test(`CI native Windows: an extra foreign rule on a ${directory ? "directory" : "file"} is refused then repaired`, {
    timeout: NATIVE_TEST_TIMEOUT_MS,
    skip: process.platform !== "win32" ? "requires native Windows PowerShell" : false,
  }, (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-foreign-rule-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const path = directory ? root : join(root, "receipt.json");
    if (!directory) fs.writeFileSync(path, "", { flag: "wx" });
    secureWindowsUpgradeBookmarkPath(path, { directory });
    assert.deepEqual(acl(path), privateAcl, "private ACL control");
    assert.ok(acl(path, true).broad > 0, "foreign grant actually installed");
    let refusals = 0;
    assert.throws(() => secureWindowsUpgradeBookmarkPath(path, { directory, verifyOnly: true,
      run(...args) { refusals++; return spawnSync(...args); },
    }), /\(verify-failed\)/);
    assert.equal(refusals, 1, "verification refusal reached PowerShell");
    assert.ok(acl(path).broad > 0, "verification did not silently repair the grant");
    secureWindowsUpgradeBookmarkPath(path, { directory });
    assert.deepEqual(acl(path), privateAcl, "repair replaces the foreign rule with the exact private ACL");
  });
}

for (const startupMs of [0, 25_000, 90_000]) {
  test(`CI Windows fixture latency: ${startupMs}ms startup can reach the native ACL assertions`, () => {
    let calls = 0;
    const run = (_command, _args, options) => {
      calls++;
      assert.ok(Number.isSafeInteger(options.timeout) && options.timeout > 0);
      return startupMs >= options.timeout
        ? { status: null, error: Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" }) }
        : { status: 0, stdout: JSON.stringify(privateAcl) };
    };
    let result;
    try {
      result = acl("C:\\fixture\\receipt.json", false, false, { run, environment: { SystemRoot: "C:\\Windows" } });
    } finally { assert.equal(calls, 1, "native fixture timeout decision was reached"); }
    assert.deepEqual(result, privateAcl);
  });
}

test("CI native Windows: elevated group owner becomes the individual owner before receipt bytes", {
  timeout: NATIVE_TEST_TIMEOUT_MS,
  skip: process.platform !== "win32" ? "requires native Windows DACLs" : false,
}, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-admin-owner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "bookmarks");
  fs.mkdirSync(directory);
  const starting = acl(directory, false, true);
  if (!starting.elevated) return t.skip("requires an elevated Windows token");
  assert.equal(starting.administratorOwned, true, "reproduced the runner's group ownership");
  assert.ok(acl(directory, true).broad > 0, "unrelated read grant was installed");
  let writes = 0, readbacks = 0, groupOwnedFiles = 0;
  const path = saveUpgradeBookmark(record, { directory, now,
    windowsAcl(target, options) {
      if (!options.directory && !options.verifyOnly) {
        assert.equal(acl(target, false, true).administratorOwned, true);
        groupOwnedFiles++;
      }
      secureWindowsUpgradeBookmarkPath(target, options);
    },
    io: { ...fs, writeFileSync(fd, bytes) {
      writes++;
      assert.deepEqual(acl(directory), privateAcl);
      assert.deepEqual(acl(join(directory, fs.readdirSync(directory)[0])), privateAcl);
      return fs.writeFileSync(fd, bytes);
    }, readFileSync(fd) { readbacks++; return fs.readFileSync(fd); } },
  });
  assert.equal(groupOwnedFiles, 1);
  assert.equal(writes, 1);
  assert.equal(readbacks, 1);
  assert.equal(JSON.parse(fs.readFileSync(path)).bookmark, record.bookmark);
  assert.deepEqual(acl(path), privateAcl);
  assert.equal(acl(path, false, true).administratorOwned, true, "owner drift was installed before verification");
  let verifyCalls = 0;
  assert.throws(() => secureWindowsUpgradeBookmarkPath(path, { verifyOnly: true,
    run(...args) { verifyCalls++; return spawnSync(...args); },
  }), /could not be protected and verified/);
  assert.equal(verifyCalls, 1, "native verification rejected group ownership");
  secureWindowsUpgradeBookmarkPath(path);
  assert.deepEqual(acl(path), privateAcl, "protect control restores individual ownership");
});

for (const inheritedBroadAccess of [true, false]) {
  test(`R152-02 native Windows: ${inheritedBroadAccess ? "broad inherited" : "private"} ACL control`, {
    timeout: NATIVE_TEST_TIMEOUT_MS,
    skip: process.platform !== "win32" ? "requires native Windows DACLs" : false,
  }, (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-acl-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    secureWindowsUpgradeBookmarkPath(root, { directory: true });
    if (inheritedBroadAccess) assert.ok(acl(root, true).broad > 0);
    const directory = join(root, "bookmarks");
    fs.mkdirSync(directory);
    if (inheritedBroadAccess) assert.ok(acl(directory).broad > 0, "broad access actually reached the receipt directory");
    let writes = 0;
    const io = { ...fs, writeFileSync(fd, bytes) {
      writes++;
      const [name] = fs.readdirSync(directory);
      assert.deepEqual(acl(directory), privateAcl);
      assert.deepEqual(acl(join(directory, name)), privateAcl, "file is private before its first identifying byte");
      return fs.writeFileSync(fd, bytes);
    } };
    const path = saveUpgradeBookmark(record, { directory, now, io });
    assert.equal(writes, 1);
    assert.deepEqual(acl(path), privateAcl);
    assert.equal(JSON.parse(fs.readFileSync(path)).bookmark, record.bookmark);
    let readbacks = 0;
    assert.throws(() => saveUpgradeBookmark(record, {
      directory, now, io: { ...fs, readFileSync(fd) {
        readbacks++;
        const result = fs.readFileSync(fd);
        const added = fs.readdirSync(directory).find((name) => join(directory, name) !== path);
        assert.ok(acl(join(directory, added), true).broad > 0);
        return result;
      } },
    }), /could not be protected and verified/);
    assert.equal(readbacks, 1, "revocation was exercised during readback");
  });
}

for (const folder of ["ascii-profile", "caf\u00e9-\u4e2d-\ud83d\udcc1"]) {
  test(`R152-03 native Windows: OEM 437 stdin with ${folder === "ascii-profile" ? "ASCII" : "Unicode"} path`, {
    timeout: NATIVE_TEST_TIMEOUT_MS,
    skip: process.platform !== "win32" ? "requires native Windows PowerShell" : false,
  }, (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "receipt-codepage-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = join(root, folder, "bookmarks");
    let nativeCalls = 0, writes = 0;
    const path = saveUpgradeBookmark(record, { directory, now,
      windowsAcl(target, options) {
        secureWindowsUpgradeBookmarkPath(target, { ...options, run(command, args, options) {
          nativeCalls++;
          const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
          const prefix = "[Console]::InputEncoding = [Text.Encoding]::GetEncoding(437); if ([Console]::InputEncoding.CodePage -ne 437) { exit 2 };\n";
          return spawnSync(command, [...args.slice(0, -1), Buffer.from(prefix + script, "utf16le").toString("base64")], options);
        } });
      },
      io: { ...fs, writeFileSync(fd, bytes) {
        writes++;
        assert.deepEqual(acl(directory), privateAcl);
        assert.deepEqual(acl(join(directory, fs.readdirSync(directory)[0])), privateAcl);
        return fs.writeFileSync(fd, bytes);
      } },
    });
    assert.equal(nativeCalls, 4, "native protect and verify gates used OEM input encoding");
    assert.equal(writes, 1);
    assert.equal(JSON.parse(fs.readFileSync(path)).bookmark, record.bookmark);
    assert.deepEqual(acl(path), privateAcl);
  });
}
