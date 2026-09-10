param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ContractPath
)

$ErrorActionPreference = "Stop"

function Refuse-PublicNpmContract([string]$Code) {
  [Console]::Error.WriteLine("PUBLIC_NPM_REFUSED $Code")
  exit 1
}

try {
  $contract = [System.IO.File]::ReadAllText($ContractPath) | ConvertFrom-Json
} catch {
  Refuse-PublicNpmContract "contract_unreadable"
}

$propertyNames = @($contract.PSObject.Properties.Name | Sort-Object)
$expectedProperties = @("arguments", "executable", "expected_command", "schema")
if (($propertyNames -join "`n") -cne ($expectedProperties -join "`n")) {
  Refuse-PublicNpmContract "contract_shape"
}
if ($contract.schema -ne 1 -or $contract.executable -cne "npm.cmd") {
  Refuse-PublicNpmContract "contract_identity"
}

[string[]]$arguments = @($contract.arguments)
[string[]]$fixedArguments = @(
  "install",
  "--global",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix"
)
if ($arguments.Count -ne 8) {
  Refuse-PublicNpmContract "argument_count"
}
for ($index = 0; $index -lt $fixedArguments.Count; $index += 1) {
  if ($arguments[$index] -cne $fixedArguments[$index]) {
    Refuse-PublicNpmContract "argument_contract"
  }
}
foreach ($path in @($arguments[6], $arguments[7])) {
  if (-not [System.IO.Path]::IsPathRooted($path) -or $path -match '["%\^!&|<>()\r\n]') {
    Refuse-PublicNpmContract "path_contract"
  }
}
if (-not (Test-Path -LiteralPath $arguments[6] -PathType Container) -or
    -not (Test-Path -LiteralPath $arguments[7] -PathType Leaf)) {
  Refuse-PublicNpmContract "install_paths"
}

$commands = @(Get-Command -Name $contract.executable -CommandType Application -All -ErrorAction SilentlyContinue)
if ($commands.Count -lt 1) {
  Refuse-PublicNpmContract "npm_not_on_path"
}
try {
  $resolvedCommand = [System.IO.Path]::GetFullPath([string]$commands[0].Path)
  $expectedCommand = [System.IO.Path]::GetFullPath([string]$contract.expected_command)
} catch {
  Refuse-PublicNpmContract "npm_path_invalid"
}
if ($resolvedCommand -ine $expectedCommand) {
  Refuse-PublicNpmContract "npm_path_mismatch"
}

# This is deliberately the same command surface the field guide gives an
# owner: PowerShell resolves npm.cmd through PATH, enters the batch shim, and
# preserves the prefix/archive paths as two arguments through array splatting.
& $contract.executable @arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
