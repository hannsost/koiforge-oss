$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$downloadRoot = Join-Path $root 'external-data/downloads'
New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null

$headers = @{ 'User-Agent'='KOIForge open-data bootstrap (contact: admin@example.org)' }

function Download-IfMissing([string]$url, [string]$targetPath, [hashtable]$extraHeaders = $null) {
  if (Test-Path $targetPath) {
    Write-Host "Skip existing: $targetPath"
    return
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $targetPath -Parent) | Out-Null
  Write-Host "Download: $url"
  if ($extraHeaders) {
    Invoke-WebRequest -Uri $url -Headers $extraHeaders -OutFile $targetPath -UseBasicParsing
  }
  else {
    Invoke-WebRequest -Uri $url -OutFile $targetPath -UseBasicParsing
  }
}

function Write-WithHeader([string]$sourcePath, [string]$targetPath, [string]$headerLine) {
  if (Test-Path $targetPath) {
    Write-Host "Skip existing transformed file: $targetPath"
    return
  }

  $content = Get-Content $sourcePath -Raw
  Set-Content -Path $targetPath -Value ($headerLine + "`n" + $content) -Encoding UTF8
}

function Convert-SecJsonToCsv([string]$jsonPath, [string]$csvPath) {
  if (Test-Path $csvPath) {
    Write-Host "Skip existing transformed file: $csvPath"
    return
  }

  $json = Get-Content $jsonPath -Raw | ConvertFrom-Json
  $rows = foreach($property in $json.PSObject.Properties) {
    [pscustomobject]@{
      entry = $property.Name
      cik = $property.Value.cik_str
      ticker = $property.Value.ticker
      title = $property.Value.title
    }
  }
  $rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
}

$ourAirportsDir = Join-Path $downloadRoot 'ourairports'
$openFlightsDir = Join-Path $downloadRoot 'openflights'
$referenceDir = Join-Path $downloadRoot 'reference'
$geoNamesDir = Join-Path $downloadRoot 'geonames'
$secDir = Join-Path $downloadRoot 'sec'

Download-IfMissing 'https://ourairports.com/data/airports.csv' (Join-Path $ourAirportsDir 'airports.csv')
Download-IfMissing 'https://ourairports.com/data/countries.csv' (Join-Path $ourAirportsDir 'countries.csv')
Download-IfMissing 'https://raw.githubusercontent.com/datasets/airport-codes/master/data/airport-codes.csv' (Join-Path $referenceDir 'airport-codes.csv')

Download-IfMissing 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat' (Join-Path $openFlightsDir 'routes.dat')
Write-WithHeader (Join-Path $openFlightsDir 'routes.dat') (Join-Path $openFlightsDir 'routes.csv') 'airline,airline_id,source_airport,source_airport_id,destination_airport,destination_airport_id,codeshare,stops,equipment'

Download-IfMissing 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat' (Join-Path $openFlightsDir 'airlines.dat')
Write-WithHeader (Join-Path $openFlightsDir 'airlines.dat') (Join-Path $openFlightsDir 'airlines.csv') 'airline_id,name,alias,iata,icao,callsign,country,active'

Download-IfMissing 'https://download.geonames.org/export/dump/cities5000.zip' (Join-Path $geoNamesDir 'cities5000.zip')
if (-not (Test-Path (Join-Path $geoNamesDir 'cities5000.txt'))) {
  Expand-Archive -Path (Join-Path $geoNamesDir 'cities5000.zip') -DestinationPath $geoNamesDir -Force
}
Write-WithHeader (Join-Path $geoNamesDir 'cities5000.txt') (Join-Path $geoNamesDir 'cities5000.tsv') "geonameid`tname`tasciiname`talternatenames`tlatitude`tlongitude`tfeature_class`tfeature_code`tcountry_code`tcc2`tadmin1_code`tadmin2_code`tadmin3_code`tadmin4_code`tpopulation`televation`tdem`ttimezone	modification_date"

Download-IfMissing 'https://www.sec.gov/files/company_tickers.json' (Join-Path $secDir 'company_tickers.json') $headers
Convert-SecJsonToCsv (Join-Path $secDir 'company_tickers.json') (Join-Path $secDir 'company_tickers.csv')

$files = Get-ChildItem $downloadRoot -Recurse -File
$totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
$totalMb = [math]::Round($totalBytes / 1MB, 2)

Write-Host ''
Write-Host "Open data pack ready: $totalMb MB"
$files | Select-Object FullName, Length | Format-Table -AutoSize

