param(
  [switch]$SkipStart,
  [switch]$Headed
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stateDir = Join-Path $root '.koiforge'

function Get-StateFilePath([string]$name) {
  return (Join-Path $stateDir "$name.json")
}

function Test-ProcessAlive([int]$processId) {
  try {
    Get-Process -Id $processId -ErrorAction Stop | Out-Null
    return $true
  }
  catch {
    return $false
  }
}

function Was-ServiceAlreadyRunning([string]$name) {
  $filePath = Get-StateFilePath $name
  if (-not (Test-Path $filePath)) {
    return $false
  }

  $state = Get-Content $filePath -Raw | ConvertFrom-Json
  return (Test-ProcessAlive ([int]$state.pid))
}

$hadApi = Was-ServiceAlreadyRunning 'api'
$hadWeb = Was-ServiceAlreadyRunning 'web'
$startedServices = $false

Push-Location $root
try {
  pnpm install | Out-Host
  pnpm --filter @koiforge/e2e-tests run install:browsers | Out-Host

  if (-not $SkipStart) {
    & "$PSScriptRoot/start-dev.ps1" -SkipInstall | Out-Host
    if (-not $hadApi -or -not $hadWeb) {
      $startedServices = $true
    }
  }

  $env:PLAYWRIGHT_BASE_URL = 'http://localhost:5173'

  if ($Headed) {
    pnpm --filter @koiforge/e2e-tests run test:headed | Out-Host
  }
  else {
    pnpm --filter @koiforge/e2e-tests run test | Out-Host
  }

  exit $LASTEXITCODE
}
finally {
  if (-not $SkipStart -and $startedServices) {
    & "$PSScriptRoot/stop-dev.ps1" | Out-Host
  }
  Pop-Location
}
