param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace
)

$ErrorActionPreference = "Stop"

function Test-Present($Name) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
    return "missing"
  }
  return "present"
}

function Resolve-RequiredPath($PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    throw "Workspace does not exist: $PathValue"
  }
  return (Resolve-Path -LiteralPath $PathValue).Path
}

$resolvedWorkspace = Resolve-RequiredPath $Workspace
$homePath = [Environment]::GetFolderPath("UserProfile")
$windowsPath = [Environment]::GetFolderPath("Windows")
$driveRoot = [System.IO.Path]::GetPathRoot($resolvedWorkspace).TrimEnd("\")
$normalized = $resolvedWorkspace.TrimEnd("\")

if ($normalized -eq $driveRoot -or $normalized -eq $homePath.TrimEnd("\") -or $normalized -eq $windowsPath.TrimEnd("\")) {
  throw "Refusing unsafe workspace root: $resolvedWorkspace"
}

Write-Host "MINICODE_REAL_BASE_URL: $(Test-Present 'MINICODE_REAL_BASE_URL')"
Write-Host "MINICODE_REAL_MODEL: $(Test-Present 'MINICODE_REAL_MODEL')"
Write-Host "MINICODE_REAL_API_KEY: $(Test-Present 'MINICODE_REAL_API_KEY')"
Write-Host "Model: $([Environment]::GetEnvironmentVariable('MINICODE_REAL_MODEL'))"
$executor = [Environment]::GetEnvironmentVariable('MINI_CODE_COMMAND_EXECUTOR')
if ([string]::IsNullOrWhiteSpace($executor)) {
  $executor = "host"
}
Write-Host "Command executor: $executor"

$env:MINI_CODE_MODEL_MODE = "real"
if ([string]::IsNullOrWhiteSpace($env:MINI_CODE_REAL_CONFIG)) {
  $env:MINI_CODE_REAL_CONFIG = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\config\real-agent.example.json")).Path
}

$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tsx = Join-Path $sourceRoot "node_modules\.bin\tsx.cmd"
if (-not (Test-Path -LiteralPath $tsx)) {
  throw "Missing local tsx executable. Run npm install in $sourceRoot first."
}

Push-Location -LiteralPath $resolvedWorkspace
try {
  & $tsx (Join-Path $sourceRoot "src\index.ts")
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
