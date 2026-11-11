param(
  [string]$ApiBaseUrl = 'http://127.0.0.1:3100'
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$catalogPath = Join-Path $root 'external-data/open-data-pack.json'
$catalog = Get-Content $catalogPath -Raw | ConvertFrom-Json

function Read-HeaderColumns([string]$path, [string]$delimiter) {
  $line = Get-Content $path -TotalCount 1
  if ($delimiter -eq '\t') {
    return ($line -split "`t")
  }

  return ($line -split [regex]::Escape($delimiter))
}

foreach($dataset in $catalog.datasets) {
  $absolutePath = Join-Path $root $dataset.path
  if (-not (Test-Path $absolutePath)) {
    throw "Dataset file missing: $absolutePath"
  }

  $columns = Read-HeaderColumns $absolutePath $dataset.delimiter
  $payload = @{
    name = $dataset.name
    namespace = $dataset.namespace
    description = "Imported open data pack dataset: $($dataset.id)"
    connectorId = $dataset.connectorId
    mode = $dataset.mode
    tags = @('open-data', $dataset.id)
    source = @{
      path = $absolutePath
      delimiter = if($dataset.delimiter -eq '\t') { "`t" } else { $dataset.delimiter }
      columns = @($columns | ForEach-Object {
        @{
          name = $_
          type = if($_ -match 'latitude|longitude|population|elevation|dem|cik') { 'number' } else { 'string' }
        }
      })
    }
  } | ConvertTo-Json -Depth 10

  try {
    Invoke-RestMethod -Method Post -Uri "$ApiBaseUrl/api/datasets/register" -ContentType 'application/json' -Body $payload | Out-Null
    Write-Host "Registered: $($dataset.id)"
  }
  catch {
    $response = $_.Exception.Response
    if ($response) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $body = $reader.ReadToEnd()
      $reader.Close()
      if ($body -match 'existiert bereits') {
        Write-Host "Skip existing: $($dataset.id)"
      }
      else {
        throw
      }
    }
    else {
      throw
    }
  }
}
