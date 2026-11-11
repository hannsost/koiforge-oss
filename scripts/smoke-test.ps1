param(
  [string]$ApiBaseUrl = 'http://127.0.0.1:3100'
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonGet([string]$url) {
  return Invoke-RestMethod -Method Get -Uri $url -TimeoutSec 15
}

function Invoke-JsonPost([string]$url, $body = @{}) {
  return Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 20 -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 10)
}

Write-Host 'Prüfe Healthcheck...'
$health = Invoke-JsonGet "$ApiBaseUrl/health"
if ($health.status -ne 'ok') {
  throw 'Healthcheck fehlgeschlagen.'
}

Write-Host 'Bootstrappe Beispielmodule...'
Invoke-JsonPost "$ApiBaseUrl/api/bootstrap/examples" | Out-Null

Write-Host 'Bootstrappe Beispiel-Datasets...'
Invoke-JsonPost "$ApiBaseUrl/api/bootstrap/datasets" | Out-Null

$modules = (Invoke-JsonGet "$ApiBaseUrl/api/modules").items
$connectors = (Invoke-JsonGet "$ApiBaseUrl/api/connectors").items
$datasets = (Invoke-JsonGet "$ApiBaseUrl/api/datasets").items
$events = (Invoke-JsonGet "$ApiBaseUrl/api/datasets/events").items

if ($modules.Count -lt 2) {
  throw 'Zu wenige Module gefunden.'
}

if ($connectors.Count -lt 5) {
  throw 'Zu wenige Connectoren gefunden.'
}

if ($datasets.Count -lt 3) {
  throw 'Zu wenige Datasets gefunden.'
}

if ($events.Count -lt 1) {
  throw 'Keine Data Events gefunden.'
}

Write-Host ''
Write-Host 'Smoke-Test erfolgreich.'
Write-Host "  Module    : $($modules.Count)"
Write-Host "  Connectoren: $($connectors.Count)"
Write-Host "  Datasets  : $($datasets.Count)"
Write-Host "  DataEvents: $($events.Count)"
