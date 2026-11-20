# Run one test suite and surface its failures as check-run annotations.
#
# A run's raw log needs a token to download, but annotations are public — so the failure text has to
# travel through `::error::` to be readable by anyone (including a maintainer debugging from another
# machine).
param(
  [Parameter(Mandatory = $true)][string]$Suite,
  [int]$Tail = 8
)

$output = & node $Suite 2>&1
$code = $LASTEXITCODE
$output | ForEach-Object { $_ }

if ($code -ne 0) {
  $failures = $output | Where-Object { $_ -match '^\s*(FAIL|  - )' } | Select-Object -First $Tail
  if (-not $failures) { $failures = $output | Select-Object -Last $Tail }
  foreach ($line in $failures) {
    Write-Host ("::error::" + ($line -replace "`r", ''))
  }
  exit $code
}
