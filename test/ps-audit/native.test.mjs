import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

// A base snapshot can be selected for red proofs without changing reviewed files.
// Only the statements under test run: no network, clipboard, task, or installer
// operation is invoked. OS boundaries are replaced with synthetic observations.
const root = process.env.PS_AUDIT_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const read = p => readFileSync(join(root, p), 'utf8');
const preflight = read('tools/preflight.ps1');
const line = (source, pattern) => {
  const match = source.match(pattern);
  assert.ok(match, `missing production statement: ${pattern}`);
  return match[0];
};
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const childEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATH', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const shells = process.platform === 'win32'
  ? [join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')]
  : [];
if (process.platform === 'win32') {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true, env: childEnvironment });
  if (probe.status === 0) shells.push('pwsh');
}

for (const shell of shells) {
  const ps = (body, input) => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-ps-native-'));
    try {
      const file = join(dir, 'repro.ps1');
      writeFileSync(file, '\ufeff' + "$ErrorActionPreference = 'Stop'\n" + body, 'utf8');
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        encoding: 'utf8', input, timeout: 30000, windowsHide: true, shell: false, cwd: dir,
        env: childEnvironment,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const check = (id, description, fn) => test(`${id} ${shell}: ${description}`, fn);

  check('D01', 'one CLI result retains its full path; zero and many retain counts', () => {
    const copies = line(preflight, /^\$copies = \$copies[^\n]+|^\$copies = @\(\$copies[^\n]+/m);
    const candidates = line(preflight, /^  \$knownCandidates = [^\n]+\n[^\n]+/m);
    ps(`$full = 'C:\\tester\\brain.cmd'
foreach ($count in @(1,0,2)) {
  $copies = @(); if ($count -gt 0) { $copies += $full }; if ($count -gt 1) { $copies += 'C:\\other\\brain.cmd' }
  ${copies}
  if ($copies.Count -ne $count) { throw 'CLI count changed' }
  if ($count -eq 1 -and $copies[0] -cne $full) { throw 'CLI path truncated' }
}
$packageCli = Join-Path $PWD 'brain.cmd'; [IO.File]::WriteAllText($packageCli, '')
$env:LOCALAPPDATA = Join-Path $PWD 'missing'
${candidates}
if ($knownCandidates.Count -ne 1 -or $knownCandidates[0] -cne $packageCli) { throw 'off-PATH candidate truncated' }`);
  });

  check('D02', 'literal brackets in the install folder remain discoverable', () => {
    const statement = line(preflight, /^if \(Test-Path [^\n]+install target exists[^\n]+/m);
    ps(`$fb = Join-Path $PWD 'tester [review]'
[IO.Directory]::CreateDirectory($fb) | Out-Null
[IO.File]::WriteAllText((Join-Path $fb 'brain.cmd'), '')
function Ok($m) { $script:found = $true }; function Warn($m) { throw 'existing CLI missed' }
$script:found = $false
${statement}
if (-not $script:found) { throw 'CLI not found' }`);
  });

  check('D03', 'BOM-less UTF-8 manifest preserves the exact international domain', () => {
    const statement = line(preflight, /^    \$m = Get-Content[^\n]+/m);
    ps(`$domain = ([string][char]0x6240) + '.invalid'
$file = Join-Path $PWD 'brain.manifest.json'
[IO.File]::WriteAllText($file, (@{brain=@{domain=$domain}} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$mf = @([pscustomobject]@{FullName=$file})
${statement}
if ($m.brain.domain -cne $domain) { throw 'manifest domain corrupted' }`);
  });

  check('D04', 'npm version with native exit 7 records a stopping prerequisite', () => {
    const block = preflight.slice(preflight.indexOf('$npm = Get-Command'), preflight.indexOf('Write-Host ""', preflight.indexOf('$npm = Get-Command')));
    ps(`$file = Join-Path $PWD 'npm.cmd'
[IO.File]::WriteAllText($file, "@echo off\r\necho 10.0.0\r\nexit /b 7\r\n")
function Get-Command { [pscustomobject]@{Source=$file} }
function Stop_($m) { $script:stopped++ }
$script:stopped = 0; $nodeSupported = $true
${block}
if ($script:stopped -ne 1) { throw 'failed npm accepted' }`);
    const policy = preflight.slice(0, preflight.indexOf('$script:Warned'));
    ps(`$ErrorActionPreference = 'Continue'
$callerPolicy = $ErrorActionPreference
$observed = & {
${policy}
  [string]$ErrorActionPreference
  try { $null = $undefinedAuditValue.Count; 'loose' } catch { 'strict' }
}
$preserved = $ErrorActionPreference -ceq $callerPolicy
$ErrorActionPreference = 'Stop'
if ($observed.Count -ne 2 -or $observed[0] -cne 'Stop' -or $observed[1] -cne 'strict') { throw 'preflight policy not established' }
if (-not $preserved) { throw 'preflight policy leaked to caller' }`);
    const fallback = line(preflight, /^  catch \{ if \(\$_\.Exception[^\n]+/m);
    ps(`Set-StrictMode -Version 2.0
function Ok($m) { throw 'unreachable network marked healthy' }
function Stop_($m) { $script:stopped++ }
$script:stopped = 0; $p = @('synthetic.invalid','https://synthetic.invalid')
try { throw [InvalidOperationException]::new('synthetic unavailable') }
${fallback}
if ($script:stopped -ne 1) { throw 'network exception not recorded' }`);
  });

  check('D05', 'machine prep rejects a plausible version from a failed executable', () => {
    const source = read('machine-prep/prep-windows.ps1');
    const fn = source.slice(source.indexOf('function Get-ToolVersion('), source.indexOf('function Write-Status('));
    ps(`$file = Join-Path $PWD 'node.cmd'
[IO.File]::WriteAllText($file, "@echo off\r\necho v22.0.0\r\nexit /b 7\r\n")
$FixtureDir = $null
function Get-ToolPaths { $file }
${fn}
if ($null -ne (Get-ToolVersion 'node')) { throw 'failed tool accepted' }`);
  });

  check('D06', 'rehearsal invokes the first discovered Git and Node executable', () => {
    const source = read('onboarding/start-windows-rehearsal.ps1');
    const assignments = ['git', 'node'].map(name => line(source, new RegExp(`^\\$${name} = Get-Command[^\\n]+`, 'm')));
    ps(`foreach ($name in @('git.cmd','git.bat','node.cmd','node.bat')) {
  [IO.File]::WriteAllText((Join-Path $PWD $name), "@echo off\r\necho chosen\r\n")
}
$env:PATH = ([string]$PWD) + ';' + $env:PATH
if (@(Get-Command git -CommandType Application).Count -lt 2 -or @(Get-Command node -CommandType Application).Count -lt 2) { throw 'multiple application fixture not reached' }
$expectedGit = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$expectedNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
${assignments.join('\n')}
if (@($git).Count -ne 1 -or @($node).Count -ne 1 -or $git.Source -cne $expectedGit -or $node.Source -cne $expectedNode) { throw 'discovery did not select first executable' }
foreach ($tool in @($git,$node)) { if ((& $tool.Source) -cne 'chosen') { throw 'wrong executable' } }`);
  });

  async function captured(module, exported, args) {
    const api = await import(pathToFileURL(resolve(root, module)));
    let script;
    const run = (command, argv) => { script = argv.at(-1); return { status: 0 }; };
    api[exported](...args, { environment: {SystemRoot: process.env.SystemRoot}, run });
    assert.ok(script);
    return script;
  }
  check('D07', 'signature helper receives the exact UTF-8 path', async () => {
    const script = await captured('operations/quickbooks-desktop-signed.mjs', 'verifyQbdAuthenticode', ['C:\\tester\\helper.exe','helper']);
    const statement = line(script, /\$p = [^;\n]+/);
    const input = 'C:\\tester\\\u6240\u6709\u8005\\helper.exe';
    ps(`$previousEncoding = [Console]::InputEncoding
try {
[Console]::InputEncoding = [Text.Encoding]::GetEncoding(437)
${statement}
if ($p -cne ${quote(input)}) { throw 'signature path corrupted' }
} finally { [Console]::InputEncoding = $previousEncoding }`, input);
  });
  check('D08', 'task JSON receives the exact UTF-8 manifest path', async () => {
    const script = await captured('connectors/quickbooks-desktop-binding.mjs', 'startDesktopConnectTask', [{name:'\\Financial Brain\\tester',serialized:'synthetic'}]);
    const statement = line(script, /\$p = [^\n]+/);
    const input = 'C:\\tester\\\u6240\u6709\u8005\\brain.manifest.json';
    ps(`$previousEncoding = [Console]::InputEncoding
try {
[Console]::InputEncoding = [Text.Encoding]::GetEncoding(437)
${statement}
if ($p.path -cne ${quote(input)}) { throw 'task manifest path corrupted' }
} finally { [Console]::InputEncoding = $previousEncoding }`, JSON.stringify({path:input}));
  });

  check('D09', 'handoff round-trips all PowerShell apostrophe delimiters', () => {
    const source = read('machine-prep/handoff/handoff-windows.ps1');
    const statements = source.match(/^\$escaped(?:Claude|Prompt) =[^\n]+/gm).join('\n');
    ps(`foreach ($code in @(39,0x2018,0x2019,0x201a,0x201b)) {
$claude = 'C:\\tester' + [char]$code + 's folder\\claude.exe'; $PromptPath = $claude
${statements}
foreach ($escaped in @($escapedClaude,$escapedPrompt)) {
  $roundTrip = [scriptblock]::Create(([string][char]39) + $escaped + [char]39).Invoke()
  if ($roundTrip.Count -ne 1 -or $roundTrip[0] -cne $claude) { throw 'handoff path changed' }
}
}`);
  });

  check('D10', 'smoke checkpoint and task context preserve Unicode paths', () => {
    const payload = read('machine-prep/installers/smoke/windows-payload.ps1');
    const limited = read('machine-prep/installers/smoke/windows-limited.ps1');
    const write = line(payload, /^    \[pscustomobject\]@\{root=[^\n]+/m);
    const load = line(payload, /^    \$checkpoint=Get-Content[^\n]+/m);
    const contextWrite = line(limited, /^  \$context \| ConvertTo-Json \| Set-Content[^\n]+/m);
    const contextLoad = line(limited, /^  \$context = Get-Content[^\n]+/m);
    ps(`$root = 'C:\\tester\\' + [char]0x6240 + [char]0x6709 + [char]0x8005
$state = Join-Path $PWD 'state.json'; function Property($name) { 'synthetic-product' }
${write}
${load}
if ($checkpoint.root -cne $root) { throw 'checkpoint path corrupted' }
$contextPath = Join-Path $PWD 'context.json'; $ContextFile = $contextPath
$context = @{path=$root}
${contextWrite}
${contextLoad}
if ($context.path -cne $root) { throw 'context path corrupted' }`);
  });

  check('D11', 'clipboard boundary preserves non-ASCII text before validation', async () => {
    const api = await import(pathToFileURL(resolve(root, 'operations/custom-api-clipboard.mjs')));
    let script;
    api.readCustomApiClipboard({ platform:'win32', environment:{SystemRoot:process.env.SystemRoot}, spawn:(command, args) => { script=args.at(-1); return {status:0,stdout:''}; } });
    // Never touch the desktop clipboard. A synthetic cmdlet returns role text.
    const result = ps(`$previousEncoding = [Console]::OutputEncoding
try {
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437)
function Get-Clipboard { 'tester ' + [char]0x6240 }
& {
${script}
} | Out-Default
} finally { [Console]::OutputEncoding = $previousEncoding }`);
    assert.equal(result, 'tester \u6240');
  });
}
if (!shells.length) test('native PowerShell reproductions', {skip:'PowerShell unavailable'}, () => {});
