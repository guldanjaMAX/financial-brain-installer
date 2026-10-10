import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { saveUpgradeBookmark, secureWindowsUpgradeBookmarkPath } from "../operations/upgrade-bookmark.mjs";
import { windowsFileChildEnvironment } from "../operations/current-user-file.mjs";

// Native tests touch only synthetic receipt paths. They never invoke a
// credential helper, account endpoint, scheduler, or the installer CLI.
function acl(path, broaden = false, administratorOwner = false) {
  const env = windowsFileChildEnvironment();
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
        Set-Acl -LiteralPath $request.path -AclObject $acl
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
        Set-Acl -LiteralPath $request.path -AclObject $acl
        $acl = Get-Acl -LiteralPath $request.path
      }
      $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
      $broad = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid.Value }).Count
      [Console]::Out.Write((@{ broad = $broad; protected = $acl.AreAccessRulesProtected; owner = ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value); rules = $rules.Count } | ConvertTo-Json -Compress))
    } catch { exit 1 }
  `;
  const result = spawnSync(win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      input: JSON.stringify({ path, broaden, administratorOwner }), encoding: "utf8", env, shell: false,
      timeout: 15_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  assert.equal(result.status, 0, "native fixture ACL operation completed");
  return JSON.parse(result.stdout);
}

const record = {
  account_id: "fixture-account", database_id: "fixture-db", bookmark: "fixture-before-update",
  from_version: "0.4.1", to_version: "0.4.11", manifest_sha256: "0".repeat(64),
};
const now = () => new Date("2026-10-10T12:00:00.000Z");
const privateAcl = { broad: 0, protected: true, owner: true, rules: 1 };

test("CI native Windows: elevated group owner becomes the individual owner before receipt bytes", {
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
