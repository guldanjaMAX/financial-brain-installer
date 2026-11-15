// Explicit native desktop rehearsal. No Wrangler, manifest, or credential call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareOAuthChildEnvironment } from "../../operations/cloudflare-oauth-session.mjs";

assert.equal(process.platform, "win32", "requires a Windows interactive desktop");
const root = mkdtempSync(join(tmpdir(), "tester-signin-window-"));
const title = `tester sign-in ${basename(root).slice(-6)}`;
const literal = value => `'${value.replaceAll("'", "''")}'`;
const moduleUrl = new URL("../../operations/windows-update-signin.mjs", import.meta.url).href;
const environmentUrl = new URL("../../operations/cloudflare-oauth-session.mjs", import.meta.url).href;
try {
  const fake = join(root, "tester sign-in.mjs");
  const parent = join(root, "tester update.mjs");
  const ready = join(root, "ready.json");
  const complete = join(root, "complete.json");
  const background = join(root, "background.json");
  writeFileSync(fake, `
    import { writeFileSync } from 'node:fs';
    process.title = ${JSON.stringify(title)};
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({
      inputTTY: process.stdin.isTTY === true, outputTTY: process.stdout.isTTY === true,
      pid: process.pid
    }));
    console.log('Synthetic sign-in: waiting for tester input.');
    const timer = setTimeout(() => process.exit(9), 45000);
    process.stdin.once('data', () => { clearTimeout(timer); process.exit(0); });
    process.stdin.resume();
  `);
  writeFileSync(parent, `
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { launchWindowsCloudflareSignIn } from ${JSON.stringify(moduleUrl)};
    import { cloudflareOAuthChildEnvironment } from ${JSON.stringify(environmentUrl)};
    const result = launchWindowsCloudflareSignIn({
      profile: 'financial-brain-' + 'a'.repeat(24),
      workingDirectory: ${JSON.stringify(root)},
      environment: cloudflareOAuthChildEnvironment(), timeoutMs: 60000,
      processRunner(command, args, options) {
        // Replace only the credential-bearing child with an input-waiting fake.
        // The production launcher still owns Start-Process, visibility and wait.
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        const helper = ${JSON.stringify(fileURLToPath(new URL("../../operations/windows-update-signin-cli.mjs", import.meta.url)))};
        if (!script.includes(helper)) throw new Error('helper boundary not found');
        const replaced = script.replace(helper, ${JSON.stringify(fake)});
        return spawnSync(command, [...args.slice(0, -1), Buffer.from(replaced, 'utf16le').toString('base64')], options);
      }
    });
    writeFileSync(${JSON.stringify(complete)}, JSON.stringify({status: result.status,
      backgroundInputTTY: process.stdin.isTTY === true, backgroundOutputTTY: process.stdout.isTTY === true}));
    process.exitCode = result.status;
  `);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class TesterWindow {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  public static bool Visible(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return false;
    try { return IsWindowVisible(GetConsoleWindow()); }
    finally { FreeConsole(); }
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Explicit, Size=20)] public struct Input {
    [FieldOffset(0)] public short type;
    [FieldOffset(4)] public int down;
    [FieldOffset(8)] public short repeat;
    [FieldOffset(10)] public short key;
    [FieldOffset(14)] public ushort character;
  }
  [DllImport("kernel32.dll", EntryPoint="WriteConsoleInputW")] static extern bool WriteInput(IntPtr handle, Input[] records, uint length, out uint written);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Enter(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return false;
    IntPtr handle = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    try {
      uint written;
      return WriteInput(handle, new Input[] {
        new Input { type=1, down=1, repeat=1, key=13, character=13 },
        new Input { type=1, down=0, repeat=1, key=13, character=13 }
      }, 2, out written) && written == 2;
    } finally { CloseHandle(handle); FreeConsole(); }
  }
}
'@
$job = Start-Job -ScriptBlock {
  param($node, $parent, $background)
  Add-Type 'using System; using System.Runtime.InteropServices; public class TesterConsole { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
  @{ consoleWindow = [TesterConsole]::GetConsoleWindow().ToInt64() } | ConvertTo-Json | Set-Content -LiteralPath $background
  & $node $parent
} -ArgumentList ${literal(process.execPath)}, ${literal(parent)}, ${literal(background)}
try {
  $deadline = (Get-Date).AddSeconds(30)
  while (!(Test-Path -LiteralPath ${literal(ready)}) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (!(Test-Path -LiteralPath ${literal(ready)})) { throw 'fake child did not start' }
  $child = Get-Content -LiteralPath ${literal(ready)} -Raw | ConvertFrom-Json
  if (![TesterWindow]::Visible($child.pid)) { throw 'visible synthetic console not found' }
  Start-Sleep -Milliseconds 800
  if (Test-Path -LiteralPath ${literal(complete)}) { throw 'update continued before fake sign-in exited' }
  if (![TesterWindow]::Enter($child.pid)) { throw 'could not send input to synthetic console' }
  $job | Wait-Job -Timeout 20 | Out-Null
  if ($job.State -ne 'Completed') { throw 'background update did not finish' }
  $job | Receive-Job
  Write-Output 'visible_window=true waited_for_input=true continued_after_exit=true'
} finally { $job | Stop-Job; $job | Remove-Job }
`;
  const result = spawnSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 90000, windowsHide: true, env: cloudflareOAuthChildEnvironment() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const child = JSON.parse(readFileSync(ready, "utf8"));
  const update = JSON.parse(readFileSync(complete, "utf8"));
  assert.equal(JSON.parse(readFileSync(background, "utf8")).consoleWindow, 0);
  assert.equal(child.inputTTY, true);
  assert.equal(child.outputTTY, true);
  assert.equal(update.backgroundInputTTY, false);
  assert.equal(update.backgroundOutputTTY, false);
  assert.equal(update.status, 0);
  console.log(result.stdout.trim());
  console.log("background_console=false child_tty=true status=0 credential_calls=0");
} finally {
  rmSync(root, { recursive: true, force: true });
}
