$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stateDir = Join-Path $root '.koiforge'

function Get-StateFilePath([string]$name) {
  return (Join-Path $stateDir "$name.json")
}

function Stop-ServiceProcess([string]$name, [string]$description) {
  $filePath = Get-StateFilePath $name
  if (-not (Test-Path $filePath)) {
    Write-Host "$description läuft nicht oder wurde bereits gestoppt."
    return
  }

  $state = Get-Content $filePath -Raw | ConvertFrom-Json
  $processId = [int]$state.pid

  try {
    Get-Process -Id $processId -ErrorAction Stop | Out-Null
    & taskkill /PID $processId /T /F | Out-Null
    Write-Host "$description gestoppt (PID $processId)."
  }
  catch {
    Write-Host "$description war nicht mehr aktiv."
  }

  Remove-Item $filePath -Force -ErrorAction SilentlyContinue
}

Stop-ServiceProcess -name 'web' -description 'Console-Web'
Stop-ServiceProcess -name 'api' -description 'Control-Plane-API'
