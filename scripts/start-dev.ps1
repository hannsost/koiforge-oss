param(
  [switch]$SkipInstall,
  [int]$TimeoutSeconds = 90,
  [int]$ApiPort = 3100,
  [int]$WebPort = 5173
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stateDir = Join-Path $root '.koiforge'
$logDir = Join-Path $stateDir 'logs'

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-StateFilePath([string]$name) {
  return (Join-Path $stateDir "$name.json")
}

function Read-State([string]$name) {
  $filePath = Get-StateFilePath $name
  if (-not (Test-Path $filePath)) {
    return $null
  }

  return (Get-Content $filePath -Raw | ConvertFrom-Json)
}

function Write-State([string]$name, [hashtable]$value) {
  $filePath = Get-StateFilePath $name
  ($value | ConvertTo-Json) | Set-Content -Path $filePath -Encoding UTF8
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

function Wait-ForUrl([string]$url, [int]$timeoutSeconds, [string]$expectedContent = '') {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        if ([string]::IsNullOrWhiteSpace($expectedContent) -or $response.Content -match [regex]::Escape($expectedContent)) {
          return $true
        }
      }
    }
    catch {
      Start-Sleep -Seconds 1
      continue
    }

    Start-Sleep -Seconds 1
  }

  return $false
}

function Start-ServiceProcess(
  [string]$name,
  [string]$command,
  [string]$readyUrl,
  [string]$description,
  [int]$timeoutSeconds,
  [string]$expectedContent,
  [string[]]$environmentAssignments
) {
  $existing = Read-State $name
  if ($existing -and (Test-ProcessAlive ([int]$existing.pid))) {
    Write-Host "$description läuft bereits unter PID $($existing.pid)."
    return
  }

  $logFilePath = Join-Path $logDir "$name.log"
  $escapedRoot = $root.Replace("'", "''")
  $escapedLog = $logFilePath.Replace("'", "''")
  $envPrefix = ($environmentAssignments | ForEach-Object {
    $parts = $_.Split('=', 2)
    '$env:' + $parts[0] + " = '" + $parts[1].Replace("'", "''") + "'"
  }) -join '; '
  $psCommand = "$envPrefix; Set-Location '$escapedRoot'; pnpm $command *> '$escapedLog'"

  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $psCommand `
    -PassThru `
    -WindowStyle Hidden

  Write-State $name @{
    pid = $process.Id
    command = "pnpm $command"
    url = $readyUrl
    log = $logFilePath
    startedAt = (Get-Date).ToString('o')
  }

  Write-Host "$description gestartet (PID $($process.Id)). Warte auf Bereitschaft..."

  if (-not (Wait-ForUrl -url $readyUrl -timeoutSeconds $timeoutSeconds -expectedContent $expectedContent)) {
    throw "$description wurde nicht rechtzeitig bereit. Siehe Log: $logFilePath"
  }

  Write-Host "$description ist bereit unter $readyUrl"
}

if (-not $SkipInstall) {
  Write-Host 'Installiere/prüfe Workspace-Abhängigkeiten...'
  Push-Location $root
  try {
    pnpm install | Out-Host
  }
  finally {
    Pop-Location
  }
}

$apiBaseUrl = "http://127.0.0.1:$ApiPort"
$webBaseUrl = "http://localhost:$WebPort"

Start-ServiceProcess `
  -name 'api' `
  -command 'api:dev' `
  -readyUrl "$apiBaseUrl/health" `
  -description 'Control-Plane-API' `
  -timeoutSeconds $TimeoutSeconds `
  -expectedContent 'koiforge-control-plane-api' `
  -environmentAssignments @("PORT=$ApiPort")

Start-ServiceProcess `
  -name 'web' `
  -command 'web:dev' `
  -readyUrl $webBaseUrl `
  -description 'Console-Web' `
  -timeoutSeconds $TimeoutSeconds `
  -expectedContent 'KOIForge Console' `
  -environmentAssignments @(
    "KOIFORGE_WEB_PORT=$WebPort",
    "VITE_API_BASE_URL=$apiBaseUrl"
  )

Write-Host ''
Write-Host 'KOIForge läuft jetzt lokal:'
Write-Host "  API: $apiBaseUrl/health"
Write-Host "  UI : $webBaseUrl"
Write-Host ''
Write-Host 'Logs liegen unter .koiforge/logs/'
