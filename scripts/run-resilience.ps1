param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $root
try {
  & pnpm --filter @koiforge/resilience-lab run run -- @Args
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}

