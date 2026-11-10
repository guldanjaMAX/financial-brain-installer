[CmdletBinding()]
param([switch]$SelfCheck)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
  $root = $PSScriptRoot
  # The signed MSI must authenticate this receipt. Unsigned builds are review
  # artifacts; local digests detect drift, not a malicious same-user rewrite.
  function Assert-Plain($item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe tree' }
    if ($item.PSObject.Properties['LinkType'] -and $item.LinkType) { throw 'linked entry' }
  }
  $ancestor = Get-Item -LiteralPath $root
  while ($null -ne $ancestor) { Assert-Plain $ancestor; $ancestor = $ancestor.Parent }
  Assert-Plain (Get-Item -LiteralPath (Join-Path $root 'payload-receipt.json'))
  $receipt = Get-Content -Raw -LiteralPath (Join-Path $root 'payload-receipt.json') | ConvertFrom-Json
  function Read-PlainTree([string]$directory) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
      Assert-Plain $entry
      $entry
      if ($entry.PSIsContainer) { Read-PlainTree $entry.FullName }
    }
  }
  $items = @(Read-PlainTree $root)
  $actual = @()
  $expected = @{}
  foreach ($row in $receipt.inventory) {
    if ($expected.ContainsKey($row.path)) { throw 'duplicate entry' }
    $expected[$row.path] = $row
  }
  foreach ($item in $items) {
    Assert-Plain $item
    $path = $item.FullName.Substring($root.Length + 1).Replace('\', '/')
    if ($path -eq 'payload-receipt.json') { continue }
    $actual += $path
    if (-not $expected.ContainsKey($path)) { throw 'extra entry' }
    $row = $expected[$path]
    if ($item.PSIsContainer) { if ($row.kind -ne 'directory') { throw 'kind mismatch' } }
    else {
      if ($row.kind -ne 'file' -or $item.Length -ne $row.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256) { throw 'digest mismatch' }
    }
  }
  if ($actual.Count -ne @($receipt.inventory).Count) { throw 'missing entry' }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $root 'runtime\node.exe'
  $info.UseShellExecute = $false
  $info.Arguments = '"' + (Join-Path $root 'launcher.mjs') + '"'
  if ($SelfCheck) { $info.Arguments += ' --self-check'; $info.CreateNoWindow = $true }
  $info.EnvironmentVariables.Clear()
  foreach ($name in @('SystemRoot','WINDIR','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $info.EnvironmentVariables[$name] = $value }
  }
  $process = [Diagnostics.Process]::Start($info)
  $process.WaitForExit()
  exit $process.ExitCode
} catch {
  [Console]::Error.WriteLine('PAYLOAD_LAUNCH_REFUSED=1')
  exit 2
}
